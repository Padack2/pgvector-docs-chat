import { CHECKPOINT_SCHEMA, checkpointPool } from "./db/checkpointer";

// 답변 피드백. 답변이 만들어진 턴의 마지막 체크포인트(thread_id, checkpoint_id)마다 1건이며, 다시 보내면 갱신한다.
// 질문·검색어·출처는 그 체크포인트에서 조회하므로 저장하지 않는다 (scripts/feedback-export.ts, docs/schema.md)
export const FEEDBACK_SCHEMA = "feedback";
export const FEEDBACK_REASONS = ["wrong", "irrelevant", "code", "other"] as const;
export const COMMENT_MAX_LENGTH = 500;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
// reason·comment는 👎일 때만
export type Feedback = { rating: "up" | "down"; reason: FeedbackReason | null; comment: string | null };

// 존재하는 체크포인트에만 저장한다 (로그인 없는 공개 엔드포인트라 임의 id로 행이 쌓이지 않게). 저장했으면 true
export async function saveFeedback(threadId: string, checkpointId: string, feedback: Feedback) {
  const { rowCount } = await checkpointPool.query(
    `INSERT INTO ${FEEDBACK_SCHEMA}.answer_feedback (thread_id, checkpoint_id, rating, reason, comment)
     SELECT $1, $2, $3, $4, $5
     WHERE EXISTS (
       SELECT 1 FROM ${CHECKPOINT_SCHEMA}.checkpoints WHERE thread_id = $1 AND checkpoint_ns = '' AND checkpoint_id = $2
     )
     ON CONFLICT (thread_id, checkpoint_id) DO UPDATE
     SET rating = EXCLUDED.rating, reason = EXCLUDED.reason, comment = EXCLUDED.comment, updated_at = now()`,
    [threadId, checkpointId, feedback.rating, feedback.reason, feedback.comment],
  );
  return rowCount === 1;
}

// 대화의 피드백 전체 (checkpoint_id → 피드백)
export async function loadFeedback(threadId: string) {
  const { rows } = await checkpointPool.query<Feedback & { checkpoint_id: string }>(
    `SELECT checkpoint_id, rating, reason, comment FROM ${FEEDBACK_SCHEMA}.answer_feedback WHERE thread_id = $1`,
    [threadId],
  );
  return new Map(rows.map(({ checkpoint_id, ...feedback }) => [checkpoint_id, feedback as Feedback]));
}
