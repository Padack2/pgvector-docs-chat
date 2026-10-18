import { NextResponse } from "next/server";
import { z } from "zod";
import { COMMENT_MAX_LENGTH, FEEDBACK_REASONS, saveFeedback } from "@/lib/feedback";

// 답변 피드백 저장. 같은 답변에 다시 보내면 갱신한다. 사유(reason·comment)는 👎일 때만 받는다
const BodySchema = z.discriminatedUnion("rating", [
  z.object({ threadId: z.uuid(), checkpointId: z.string().min(1).max(64), rating: z.literal("up") }),
  z.object({
    threadId: z.uuid(),
    checkpointId: z.string().min(1).max(64),
    rating: z.literal("down"),
    reason: z.enum(FEEDBACK_REASONS).optional(),
    comment: z.string().trim().max(COMMENT_MAX_LENGTH).optional(),
  }),
]);

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const body = parsed.data;
  const reason = body.rating === "down" ? (body.reason ?? null) : null;
  const comment = body.rating === "down" ? body.comment || null : null;
  const saved = await saveFeedback(body.threadId, body.checkpointId, { rating: body.rating, reason, comment });
  if (!saved) return NextResponse.json({ error: "대화를 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
