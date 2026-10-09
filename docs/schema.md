# DB Schema

## doc_chunks

문서 청크와 임베딩을 저장하는 테이블.

```sql
CREATE TABLE doc_chunks (
  id          BIGSERIAL PRIMARY KEY,
  content     TEXT NOT NULL,
  embedding   VECTOR(1536),
  source_url  TEXT,
  title       TEXT,
  chunk_index INT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON doc_chunks
  USING hnsw (embedding vector_cosine_ops);
```

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | BIGSERIAL | PK |
| content | TEXT | 청크 본문 (NOT NULL) |
| embedding | VECTOR(1536) | 임베딩 벡터 |
| source_url | TEXT | 원본 문서 URL |
| title | TEXT | 원본 문서 제목 (출처 표시용) |
| chunk_index | INT | 원본 문서 내 청크 순서 |
| created_at | TIMESTAMPTZ | 생성 시각 (기본값 NOW()) |

### 인덱스
- HNSW 인덱스 (`vector_cosine_ops`): 코사인 거리(`<=>`) 기반 유사도 검색용

## 대화 체크포인트 (`langgraph` 스키마)

LangGraph `PostgresSaver`가 대화 상태를 저장하는 테이블. 테이블 정의는 패키지(`@langchain/langgraph-checkpoint-postgres`)의 마이그레이션이 관리하므로 여기서 직접 만들지 않는다.

| 테이블 | 내용 |
|---|---|
| checkpoints | 스레드(`thread_id`)별 단계마다의 상태 스냅샷 (`parent_checkpoint_id`로 이전 단계와 연결) |
| checkpoint_blobs | 상태 채널 값 (메시지 등) |
| checkpoint_writes | 노드가 쓴 중간 결과 |
| checkpoint_migrations | 적용된 마이그레이션 버전 |

### 계정과 권한

| 계정 | 용도 | 권한 |
|---|---|---|
| embed_user | 임베딩 저장 (`scripts/embed.ts`) | `doc_chunks` 읽기·쓰기·삭제 |
| readonly_user | 챗봇 검색 | `doc_chunks` 읽기 |
| checkpoint_user | 대화 체크포인트 | 자기 소유인 `langgraph` 스키마만. `doc_chunks` 접근 불가 |

`PostgresSaver.setup()`은 `CREATE SCHEMA IF NOT EXISTS`를 실행하는데, PostgreSQL은 스키마가 이미 있어도 DB의 CREATE 권한을 먼저 검사한다. 그래서 테이블을 만들 때만 권한을 임시로 준다.

```sql
-- 1. Neon SQL Editor (neondb_owner)
CREATE ROLE checkpoint_user WITH LOGIN PASSWORD '<비밀번호>';
GRANT CREATE ON DATABASE neondb TO checkpoint_user;

-- 2. pnpm --filter scripts setup-checkpointer  (스키마·테이블 생성, doc_chunks 접근 거부 확인)

-- 3. Neon SQL Editor (neondb_owner)
REVOKE CREATE ON DATABASE neondb FROM checkpoint_user;
```

패키지 업데이트로 마이그레이션이 추가되면 1의 GRANT → 2 → 3을 다시 실행한다.

### 보관과 공개 범위

- 체크포인트는 노드 실행마다 쌓인다 (질문 1개에 약 5~10개, 개당 수 KB). 30일 넘게 활동이 없는 대화는 `pnpm --filter scripts cleanup-threads -- --delete`로 지운다 (`--delete` 없이 실행하면 대상만 출력).
- 대화 id(UUID)를 아는 사람은 누구나 그 대화를 읽고 이어서 질문할 수 있다. 로그인이 없는 데모라 별도 접근 제어는 두지 않았다.
