import { NextResponse } from "next/server";
import { z } from "zod";
import type { RetrievedChunk } from "@/lib/db/pgvector";
import { graph } from "@/lib/graph";

const BodySchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) }))
    .min(1)
    // zod v4는 min(1)이 실패해도 refine을 실행하므로 빈 배열을 ?.로 방어
    .refine((messages) => messages[messages.length - 1]?.role === "user", "마지막 메시지는 user여야 합니다"),
});

// 응답은 줄 단위 JSON(NDJSON) 이벤트 스트림:
//   {"type":"token","text":"..."}                      답변 토큰 (generate 노드 것만)
//   {"type":"sources","sources":[{"title","url"}, ...]} 답변 끝난 뒤 1회. 순서가 답변의 [1], [2] 번호와 같다
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
        // messages: LLM 토큰 단위 스트림, updates: 노드가 끝날 때마다 반환한 상태 변경분
        const events = await graph.stream(parsed.data, { streamMode: ["messages", "updates"] });
        let documents: RetrievedChunk[] = [];
        for await (const [mode, chunk] of events) {
          if (mode === "messages") {
            const [message, metadata] = chunk;
            // classify·grade·rewrite의 LLM 출력도 흘러오므로 답변 노드 것만 보낸다
            if (metadata.langgraph_node === "generate" && message.text) send({ type: "token", text: message.text });
          } else {
            // 재검색하면 documents가 교체되므로 마지막 값이 답변 근거
            for (const update of Object.values(chunk)) {
              if (update?.documents) documents = update.documents;
            }
          }
        }
        send({ type: "sources", sources: documents.map((doc) => ({ title: doc.title, url: doc.source_url })) });
      } catch (error) {
        console.error(error);
        send({ type: "error", message: "답변 생성 중 오류가 발생했습니다." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}
