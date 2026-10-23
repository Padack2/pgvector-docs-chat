// langgraph 스키마에 Store 테이블(store, store_migrations)을 만든다. 최초 1회, 그리고 패키지 업데이트로 마이그레이션이 추가됐을 때 실행
// setup()이 CREATE SCHEMA IF NOT EXISTS를 실행하므로 스키마가 이미 있어도 DB CREATE 권한이 필요하다. 실행 전후로 Neon에서 권한을 임시 부여·회수해야 한다 (docs/schema.md)
import { CHECKPOINT_SCHEMA } from "../apps/web/src/lib/db/checkpointer";
import { store } from "../apps/web/src/lib/db/store";

await store.setup();

// 쓰기·읽기·삭제가 되는지 임시 namespace로 확인한다
const namespace = ["setup-check"];
await store.put(namespace, "ping", { ok: true });
const item = await store.get(namespace, "ping");
await store.delete(namespace, "ping");
const deleted = await store.get(namespace, "ping");
console.log(`${CHECKPOINT_SCHEMA} store round trip: put/get ${item?.value.ok === true ? "ok" : "FAILED"}, delete ${deleted === null ? "ok" : "FAILED"}`);
await store.stop();
if (item?.value.ok !== true || deleted !== null) process.exit(1);
