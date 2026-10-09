// langgraph 스키마와 체크포인트 테이블을 만든다. 최초 1회, 그리고 패키지 업데이트로 마이그레이션이 추가됐을 때 실행
// checkpoint_user는 평소 DB CREATE 권한이 없으므로 실행 전후로 Neon에서 권한을 임시 부여·회수해야 한다 (docs/schema.md)
import pg from "pg";
import { CHECKPOINT_SCHEMA, checkpointer } from "../apps/web/src/lib/db/checkpointer";

await checkpointer.setup();
await checkpointer.end();

const client = new pg.Client({ connectionString: process.env.CHECKPOINT_DATABASE_URL });
await client.connect();

const { rows } = await client.query<{ relname: string }>(
  `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
  [CHECKPOINT_SCHEMA],
);
console.log(`${CHECKPOINT_SCHEMA} tables: ${rows.map((row) => row.relname).join(", ")}`);

// 권한 분리 확인: 체크포인트 계정으로는 문서 테이블을 읽을 수 없어야 한다
const canReadDocs = await client.query("SELECT 1 FROM public.doc_chunks LIMIT 1").then(
  () => true,
  (error) => {
    if (!/permission denied/.test(String(error))) throw error;
    return false;
  },
);
console.log(canReadDocs ? "WARNING: checkpoint_user can read doc_chunks" : "doc_chunks access denied (expected)");
await client.end();
if (canReadDocs) process.exit(1);
