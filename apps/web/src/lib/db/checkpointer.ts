import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

// 대화 기록(체크포인트)은 langgraph 스키마에만 쓸 수 있는 전용 계정으로 저장한다 (문서 테이블 권한 없음, docs/schema.md)
export const CHECKPOINT_SCHEMA = "langgraph";

export const checkpointer = PostgresSaver.fromConnString(process.env.CHECKPOINT_DATABASE_URL ?? "", {
  schema: CHECKPOINT_SCHEMA,
});
