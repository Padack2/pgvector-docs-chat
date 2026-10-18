// 답변 피드백 스키마와 테이블을 만든다. 최초 1회 (다시 실행해도 안전)
// checkpoint_user는 평소 DB CREATE 권한이 없으므로 실행 전후로 Neon에서 권한을 임시 부여·회수해야 한다 (docs/schema.md)
import pg from "pg";
import { COMMENT_MAX_LENGTH, FEEDBACK_REASONS, FEEDBACK_SCHEMA } from "../apps/web/src/lib/feedback";

const client = new pg.Client({ connectionString: process.env.CHECKPOINT_DATABASE_URL });
await client.connect();
await client.query(`CREATE SCHEMA IF NOT EXISTS ${FEEDBACK_SCHEMA}`);
const reasons = FEEDBACK_REASONS.map((reason) => `'${reason}'`).join(", ");
await client.query(`
  CREATE TABLE IF NOT EXISTS ${FEEDBACK_SCHEMA}.answer_feedback (
    thread_id     text        NOT NULL,
    checkpoint_id text        NOT NULL,
    rating        text        NOT NULL CHECK (rating IN ('up', 'down')),
    reason        text        CHECK (reason IN (${reasons})),
    comment       text        CHECK (char_length(comment) <= ${COMMENT_MAX_LENGTH}),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, checkpoint_id),
    CHECK (rating = 'down' OR (reason IS NULL AND comment IS NULL))
  )`);
const { rows } = await client.query<{ column_name: string }>(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'answer_feedback' ORDER BY ordinal_position`,
  [FEEDBACK_SCHEMA],
);
console.log(`${FEEDBACK_SCHEMA}.answer_feedback columns: ${rows.map((row) => row.column_name).join(", ")}`);
await client.end();
