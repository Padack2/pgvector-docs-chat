// 👎 피드백을 받은 답변을 평가셋 후보로 출력한다. 질문·검색어·출처는 피드백 행에 없으므로 그 체크포인트의 상태에서 꺼낸다.
// 정답 섹션(relevant)은 사람이 출처와 문서를 보고 채운다 (eval/questions.json 형식)
//   예: pnpm --filter scripts feedback-export -- --out /tmp/candidates.json   (--out이 없으면 표준 출력)
import { writeFile } from "node:fs/promises";
import { checkpointPool } from "../apps/web/src/lib/db/checkpointer";
import { FEEDBACK_SCHEMA, type Feedback } from "../apps/web/src/lib/feedback";
import { graph } from "../apps/web/src/lib/graph";
import type { Source } from "../apps/web/src/lib/threads";

type Message = { getType(): string; text: string; additional_kwargs?: { sources?: Source[] } };

const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;

const { rows } = await checkpointPool.query<Feedback & { thread_id: string; checkpoint_id: string; updated_at: Date }>(
  `SELECT thread_id, checkpoint_id, rating, reason, comment, updated_at
   FROM ${FEEDBACK_SCHEMA}.answer_feedback WHERE rating = 'down' ORDER BY updated_at`,
);

const candidates = [];
for (const row of rows) {
  const state = await graph.getState({ configurable: { thread_id: row.thread_id, checkpoint_id: row.checkpoint_id } });
  const messages = (state.values.messages ?? []) as Message[];
  const answer = messages.at(-1);
  const question = messages.findLast((message) => message.getType() === "human");
  // 대화가 정리(cleanup-threads)되었으면 체크포인트가 없다
  if (!answer || !question) continue;
  candidates.push({
    threadId: row.thread_id,
    checkpointId: row.checkpoint_id,
    updatedAt: row.updated_at.toISOString(),
    reason: row.reason,
    comment: row.comment,
    question: question.text,
    // 후속 질문이면 classify가 대화 맥락을 반영해 다시 쓴 검색어가 평가셋 질문 후보가 된다
    searchQuery: state.values.searchQuery,
    subQueries: state.values.subQueries,
    sources: answer.additional_kwargs?.sources ?? [],
    answer: answer.text,
  });
}

const json = JSON.stringify(candidates, null, 2);
if (out) {
  await writeFile(out, json + "\n");
  console.log(`👎 ${rows.length}건 중 ${candidates.length}건 저장: ${out}`);
} else console.log(json);

// 체크포인트 커넥션 풀이 열려 있어 명시적으로 종료
process.exit(0);
