import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { CHECKPOINT_SCHEMA } from "./checkpointer";

// 대화를 넘어 유지할 사용자별 기억(프레임워크 선호)을 체크포인트와 같은 계정·스키마에 저장한다.
// PostgresStore는 기존 Pool을 받지 않아 자체 Pool을 만든다.
// 테이블은 setup-store 스크립트로 한 번만 만들고, 요청 처리 중에는 마이그레이션을 실행하지 않는다
export const store = new PostgresStore({
  connectionOptions: { connectionString: process.env.CHECKPOINT_DATABASE_URL },
  schema: CHECKPOINT_SCHEMA,
  ensureTables: false,
});
