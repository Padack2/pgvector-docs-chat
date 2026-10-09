// 마지막 활동이 보관 기간보다 오래된 대화(스레드)의 체크포인트를 지운다.
// 체크포인트는 노드 실행마다 쌓여(질문 1개에 약 5~10개, 개당 수 KB) 지우지 않으면 계속 커진다.
// 기본은 지울 대상만 출력하고, --delete를 붙여야 실제로 지운다: pnpm --filter scripts cleanup-threads -- --delete
import pg from "pg";
import { CHECKPOINT_SCHEMA, checkpointer } from "../apps/web/src/lib/db/checkpointer";

const RETENTION_DAYS = 30;
const shouldDelete = process.argv.includes("--delete");

const client = new pg.Client({ connectionString: process.env.CHECKPOINT_DATABASE_URL });
await client.connect();
// 체크포인트 JSON의 ts가 저장 시각이다 (테이블에는 시각 컬럼이 없음)
const { rows } = await client.query<{ thread_id: string; last_active: Date }>(
  `SELECT thread_id, max((checkpoint->>'ts')::timestamptz) AS last_active
   FROM ${CHECKPOINT_SCHEMA}.checkpoints
   GROUP BY thread_id
   HAVING max((checkpoint->>'ts')::timestamptz) < now() - make_interval(days => $1)
   ORDER BY last_active`,
  [RETENTION_DAYS],
);
await client.end();

console.log(`threads inactive for ${RETENTION_DAYS}+ days: ${rows.length}`);
for (const row of rows) console.log(`  ${row.thread_id}  last active ${row.last_active.toISOString()}`);
if (shouldDelete) {
  for (const row of rows) await checkpointer.deleteThread(row.thread_id);
  console.log(`deleted ${rows.length} threads`);
} else if (rows.length > 0) {
  console.log("dry run: add --delete to remove them");
}
await checkpointer.end();
