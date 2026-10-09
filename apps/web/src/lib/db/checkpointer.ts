import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

// 대화 기록(체크포인트)은 langgraph 스키마에만 쓸 수 있는 전용 계정으로 저장한다 (문서 테이블 권한 없음, docs/schema.md)
export const CHECKPOINT_SCHEMA = "langgraph";

// JS PostgresSaver(1.0.6)는 채널 버전을 정수로 1씩 올린다. 질문을 수정해 분기하면 같은 스레드의 두 분기가 같은 버전을 쓰게 되고,
// checkpoint_blobs의 기본 키 (thread_id, checkpoint_ns, channel, version)가 겹쳐 새 분기의 값이 저장되지 않는다
// (ON CONFLICT DO NOTHING → 새 분기가 다른 분기의 메시지를 읽음). Python 구현처럼 난수 접미사를 붙여 버전을 분기마다 유일하게 만든다.
// 앞부분을 0으로 채운 정수라 버전 비교(문자열 비교)의 순서는 그대로 유지된다
class BranchSafePostgresSaver extends PostgresSaver {
  getNextVersion(current: number | undefined): number {
    const counter = current === undefined ? 0 : Number.parseInt(String(current).split(".")[0], 10);
    const version = `${String(counter + 1).padStart(32, "0")}.${Math.random().toFixed(16).slice(2)}`;
    // 타입 선언은 number 버전만 허용하지만 LangGraph는 문자열 버전도 지원한다 (compareChannelVersions)
    return version as unknown as number;
  }
}

export const checkpointer = new BranchSafePostgresSaver(
  new pg.Pool({ connectionString: process.env.CHECKPOINT_DATABASE_URL }),
  undefined,
  { schema: CHECKPOINT_SCHEMA },
);
