import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { graph } from "@/lib/graph";
import { type ClarifyRequest, FRAMEWORK_LABELS } from "@/lib/graph/nodes/clarify";
import type { Framework, GraphStateUpdate, ResearchStateUpdate } from "@/lib/graph/state";
import type { Source } from "@/lib/threads";
import type { VerifyResult } from "@/lib/verify";

// Vercel 함수 최대 실행 시간(초). 이걸 넘기면 함수가 강제 종료돼 클라이언트는 에러 이벤트도 받지 못한다
export const maxDuration = 60;
// 모델이 응답 없이 멈추는 경우가 있어(2026-10-09 gemini-3.8-flash) 그래프 전체에 시간 제한을 둔다.
// maxDuration보다 짧아야 제한에 걸렸을 때 에러 이벤트를 보낼 수 있다
const GRAPH_TIMEOUT_MS = 50_000;
// 로그인 없이 브라우저를 구분하는 익명 ID 쿠키. Store의 사용자별 기억(namespace ["users", id])에 쓴다
const USER_COOKIE = "uid";
const USER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

// 대화 기록은 서버의 체크포인트에 있으므로 새 질문(message) 또는 되물음에 대한 답(resume) 하나만 받는다
const BodySchema = z
  .object({
    threadId: z.uuid(),
    message: z.string().trim().min(1).optional(),
    // clarify 노드의 interrupt에 대한 선택값. 멈춘 그래프를 이 값으로 재개한다
    resume: z.string().min(1).optional(),
    // 이어갈 체크포인트: 화면에 보이는 분기의 끝(이어서 질문·재개) 또는 수정·재시도할 질문의 직전 상태(fork).
    // 없으면 스레드의 최신 체크포인트에서 이어간다
    checkpointId: z.string().min(1).optional(),
  })
  .refine(
    (body) => (body.message === undefined) !== (body.resume === undefined),
    "message와 resume 중 하나만 보내야 합니다",
  );

// 응답은 줄 단위 JSON(NDJSON) 이벤트 스트림:
//   {"type":"start","node":"retrieve"}                  노드가 실행을 시작할 때마다 (generate 포함)
//   {"type":"step","node":"classify","needsSearch":true,"searchQuery":"...","needsClarify":false}  노드가 끝날 때마다 (generate 제외)
//   {"type":"step","node":"clarify","choice":"LangGraph"}   재개 후 고른 프레임워크 (null이면 전체 문서)
//   {"type":"branch","branch":0,"question":"..."}      하위 질문 하나의 research가 시작될 때 (병렬 실행 순서대로 0, 1, ...)
//   {"type":"step","node":"retrieve","count":10,"branch":0}   research 안쪽 노드(retrieve·grade·rewrite)의 start·step에는 branch가 붙는다
//   {"type":"step","node":"grade","isSufficient":false,"branch":0}
//   {"type":"step","node":"rewrite","searchQuery":"...","branch":0}
//   {"type":"token","text":"..."}                      답변 토큰 (generate 노드 것만)
//   {"type":"sources","sources":[{"title","url"}, ...]} 답변 끝난 뒤 1회. 하위 질문별 검색 결과를 합친 것으로, 순서가 답변의 [1], [2] 번호와 같다
//   {"type":"verify","ok":false,"blocks":2,"errors":[{"block","line","code","api","message","inSource"}, ...]}
//                                                      sources 뒤, 답변에 TS 코드 블록이 있을 때만 1회. inSource는 출처 문서 코드에도 같은 에러가 있는지
//   {"type":"interrupt","question":"...","options":[{"value","label"}, ...]}  되물음으로 그래프가 멈춤 (sources 없이 끝남)
//   {"type":"error","message":"..."}                   스트리밍 도중 실패 (이미 200을 보낸 뒤라 상태 코드로 알릴 수 없음)
export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  // 쿠키가 없거나 값이 UUID가 아니면 새로 발급한다
  const cookieId = cookies().get(USER_COOKIE)?.value;
  const isKnownUser = z.uuid().safeParse(cookieId).success;
  const userId = isKnownUser ? cookieId! : crypto.randomUUID();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        // messages: LLM 토큰 단위 스트림, updates: 노드가 끝날 때마다 반환한 상태 변경분, tasks: 노드 시작·종료
        // subgraphs: research 서브그래프 안의 retrieve·grade·rewrite 이벤트도 받는다 (이벤트 앞에 namespace가 붙음)
        const { threadId, message, resume, checkpointId } = parsed.data;
        const events = await graph.stream(
          message !== undefined ? { messages: [new HumanMessage(message)] } : new Command({ resume }),
          {
            configurable: { thread_id: threadId, checkpoint_id: checkpointId, user_id: userId },
            streamMode: ["messages", "updates", "tasks"],
            subgraphs: true,
            signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
          },
        );
        // research 실행의 namespace("research:<task id>") → 분기 번호. 병렬 분기의 안쪽 이벤트가 섞여 오므로 이걸로 구분한다
        const branches = new Map<string, number>();
        for await (const [namespace, mode, chunk] of events) {
          const branch = branches.get(namespace[0]);
          if (mode === "messages") {
            const [message, metadata] = chunk;
            // classify·grade·rewrite의 LLM 출력도 흘러오므로 답변 노드 것만 보낸다
            if (metadata.langgraph_node === "generate" && message.text) send({ type: "token", text: message.text });
          } else if (mode === "tasks") {
            // 종료 이벤트(result)는 updates로 받으므로 시작 이벤트(input)만 보낸다.
            // research는 안쪽 노드 이벤트로 보여주므로 서브그래프 자체의 시작 대신 분기 정보를 보낸다
            if (!("input" in chunk)) continue;
            if (chunk.name === "research") {
              // input은 부모 상태로 타입이 잡히지만, Send로 실행된 research는 Send에 넘긴 값({ question, framework })을 받는다
              const { question } = chunk.input as unknown as { question: string };
              branches.set(`research:${chunk.id}`, branches.size);
              send({ type: "branch", branch: branches.size - 1, question });
            } else send({ type: "start", node: chunk.name, branch });
          } else {
            // clarify 노드가 interrupt로 멈추면 updates에 __interrupt__로 그 값이 온다
            if ("__interrupt__" in chunk) {
              const [pending] = chunk.__interrupt__ as { value: ClarifyRequest }[];
              send({ type: "interrupt", ...pending.value });
              continue;
            }
            // 부모 그래프 노드와 research 서브그래프 안쪽 노드(retrieve·grade·rewrite)의 변경분이 섞여 온다
            for (const [node, value] of Object.entries(chunk)) {
              if (!value) continue;
              const update = value as GraphStateUpdate & ResearchStateUpdate;
              if (node === "classify") {
                send({
                  type: "step",
                  node,
                  needsSearch: update.needsSearch,
                  searchQuery: update.searchQuery,
                  needsClarify: (update.frameworkCandidates?.length ?? 0) >= 2,
                });
              } else if (node === "clarify") {
                const framework = update.framework as Framework | null | undefined;
                send({ type: "step", node, choice: framework ? FRAMEWORK_LABELS[framework] : null });
              } else if (node === "retrieve") {
                send({ type: "step", node, count: update.documents?.length ?? 0, branch });
              } else if (node === "grade") {
                send({ type: "step", node, isSufficient: update.isSufficient, branch });
              } else if (node === "rewrite") {
                send({ type: "step", node, searchQuery: update.searchQuery, branch });
              } else if (node === "generate") {
                // generate가 합친 답변 근거를 답변 메시지에 저장한다 (generate.ts).
                // 코드 검증(verify)을 기다리지 않고 바로 보낸다
                const [answer] = update.messages as BaseMessage[];
                send({ type: "sources", sources: (answer.additional_kwargs.sources ?? []) as Source[] });
              } else if (node === "verify") {
                // 코드 블록이 없으면 verify는 메시지를 바꾸지 않는다
                const [answer] = (update.messages ?? []) as BaseMessage[];
                const result = answer?.additional_kwargs.verify as VerifyResult | undefined;
                if (result) send({ type: "verify", ok: result.errors.length === 0, ...result });
              }
            }
          }
        }
      } catch (error) {
        console.error(error);
        // Gemini 무료 티어 한도(분당·일일) 초과가 가장 흔한 실패라 따로 안내한다
        const isQuota = /429|quota/i.test(String(error));
        const isTimeout = /abort|timeout/i.test(String(error));
        send({
          type: "error",
          message: isQuota
            ? "Gemini API 사용 한도를 넘었습니다. 1분 뒤 다시 시도하고, 계속 실패하면 일일 한도가 풀리는 내일 오전에 시도하세요."
            : isTimeout
              ? "모델 응답이 너무 오래 걸려 중단했습니다. 잠시 뒤 다시 시도하세요."
              : "서버에서 답변을 만들지 못했습니다. 잠시 뒤 다시 시도하세요.",
        });
      } finally {
        controller.close();
      }
    },
  });

  const response = new NextResponse(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
  if (!isKnownUser) {
    response.cookies.set(USER_COOKIE, userId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: USER_COOKIE_MAX_AGE,
    });
  }
  return response;
}
