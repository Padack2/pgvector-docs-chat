import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { RetrievedChunk } from "@/lib/db/pgvector";
import { graph } from "@/lib/graph";
import { type ClarifyRequest, FRAMEWORK_LABELS } from "@/lib/graph/nodes/clarify";
import type { Framework } from "@/lib/graph/state";

// Vercel 함수 최대 실행 시간(초). 이걸 넘기면 함수가 강제 종료돼 클라이언트는 에러 이벤트도 받지 못한다
export const maxDuration = 60;
// 모델이 응답 없이 멈추는 경우가 있어(2026-10-09 gemini-3.8-flash) 그래프 전체에 시간 제한을 둔다.
// maxDuration보다 짧아야 제한에 걸렸을 때 에러 이벤트를 보낼 수 있다
const GRAPH_TIMEOUT_MS = 50_000;

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
//   {"type":"step","node":"retrieve","count":5}
//   {"type":"step","node":"grade","isSufficient":false}
//   {"type":"step","node":"rewrite","searchQuery":"..."}
//   {"type":"token","text":"..."}                      답변 토큰 (generate 노드 것만)
//   {"type":"sources","sources":[{"title","url"}, ...]} 답변 끝난 뒤 1회. 순서가 답변의 [1], [2] 번호와 같다
//   {"type":"interrupt","question":"...","options":[{"value","label"}, ...]}  되물음으로 그래프가 멈춤 (sources 없이 끝남)
//   {"type":"error","message":"..."}                   스트리밍 도중 실패 (이미 200을 보낸 뒤라 상태 코드로 알릴 수 없음)
export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        // messages: LLM 토큰 단위 스트림, updates: 노드가 끝날 때마다 반환한 상태 변경분, tasks: 노드 시작·종료
        const { threadId, message, resume, checkpointId } = parsed.data;
        const events = await graph.stream(
          message !== undefined ? { messages: [new HumanMessage(message)] } : new Command({ resume }),
          {
            configurable: { thread_id: threadId, checkpoint_id: checkpointId },
            streamMode: ["messages", "updates", "tasks"],
            signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
          },
        );
        let documents: RetrievedChunk[] = [];
        let interrupted = false;
        for await (const [mode, chunk] of events) {
          if (mode === "messages") {
            const [message, metadata] = chunk;
            // classify·grade·rewrite의 LLM 출력도 흘러오므로 답변 노드 것만 보낸다
            if (metadata.langgraph_node === "generate" && message.text) send({ type: "token", text: message.text });
          } else if (mode === "tasks") {
            // 종료 이벤트(result)는 updates로 받으므로 시작 이벤트(input)만 보낸다
            if ("input" in chunk) send({ type: "start", node: chunk.name });
          } else {
            // clarify 노드가 interrupt로 멈추면 updates에 __interrupt__로 그 값이 온다
            if ("__interrupt__" in chunk) {
              interrupted = true;
              const [pending] = chunk.__interrupt__ as { value: ClarifyRequest }[];
              send({ type: "interrupt", ...pending.value });
              continue;
            }
            for (const [node, update] of Object.entries(chunk)) {
              if (!update) continue;
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
                // 재검색하면 documents가 교체되므로 마지막 값이 답변 근거
                documents = update.documents ?? [];
                send({ type: "step", node, count: documents.length });
              } else if (node === "grade") {
                send({ type: "step", node, isSufficient: update.isSufficient });
              } else if (node === "rewrite") {
                send({ type: "step", node, searchQuery: update.searchQuery });
              }
            }
          }
        }
        if (!interrupted) {
          send({ type: "sources", sources: documents.map((doc) => ({ title: doc.title, url: doc.source_url })) });
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

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}
