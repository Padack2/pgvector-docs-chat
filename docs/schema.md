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

## doc_changes

문서 동기화(`scripts/embed.ts`)가 페이지별 추가·변경·삭제를 기록하는 이력 테이블. 청크 교체와 같은 트랜잭션에서 INSERT하므로 동기화가 중단돼도 이력이 중복·누락되지 않는다. 요약은 다음 단계(`scripts/summarize-changes.ts`)가 채운다 ([ADR-011](adr/ADR-011-doc-change-history.md)).

```sql
CREATE TABLE doc_changes (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_url TEXT NOT NULL,
  title      TEXT,
  change     TEXT NOT NULL CHECK (change IN ('added', 'changed', 'removed')),
  sections   JSONB NOT NULL,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary    TEXT
);

CREATE INDEX ON doc_changes (synced_at);
CREATE INDEX ON doc_changes (source_url, synced_at);

GRANT SELECT, INSERT ON doc_changes TO embed_user;
GRANT UPDATE (summary) ON doc_changes TO embed_user;
GRANT SELECT ON doc_changes TO readonly_user;
```

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | BIGINT | PK (IDENTITY) |
| source_url | TEXT | 문서 URL (`doc_chunks.source_url`과 같은 값) |
| title | TEXT | 문서 제목 |
| change | TEXT | 페이지 단위 변경 유형: `added` / `changed` / `removed` |
| sections | JSONB | 바뀐 섹션 목록 `[{ path, change, before, after }]`. 섹션은 청크 첫 줄의 섹션 경로로 묶고, `before`·`after`는 변경 전/후 본문 (없으면 null) |
| synced_at | TIMESTAMPTZ | 기록 시각 |
| summary | TEXT | 변경 요약. NULL이면 아직 요약 전 (다음 실행에서 처리) |

### 인덱스
- `synced_at`: 최근 이력 목록 (`/changes`)
- `(source_url, synced_at)`: 대화 출처 페이지의 답변 이후 이력 조회 ("이후 변경됨" 표시)

### 비고
- 청킹 파라미터를 바꾸면 전 페이지가 `changed`로 기록된다. 문서 변경이 아니므로 필요하면 해당 이력 행을 삭제한다.

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
| embed_user | 임베딩 저장·변경 이력 기록 (`scripts/embed.ts`, `summarize-changes.ts`) | `doc_chunks` 읽기·쓰기·삭제, `doc_changes` 읽기·쓰기·`summary` 수정 |
| readonly_user | 챗봇 검색, 문서 변경 표시 | `doc_chunks`·`doc_changes` 읽기 |
| checkpoint_user | 대화 체크포인트, 답변 피드백 | 자기 소유인 `langgraph`·`feedback` 스키마만. `doc_chunks` 접근 불가 |

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

## 답변 피드백 (`feedback` 스키마)

답변마다 받은 👍/👎와 사유. 답변이 만들어진 턴의 마지막 체크포인트마다 1건이며 다시 보내면 갱신한다. 질문·검색어·출처는 그 체크포인트에서 조회하므로 저장하지 않는다 ([ADR-010](adr/ADR-010-feedback-storage.md)).

### answer_feedback

| 컬럼 | 타입 | 설명 |
|---|---|---|
| thread_id | text | 대화 id (`langgraph.checkpoints.thread_id`) |
| checkpoint_id | text | 답변으로 끝난 턴의 마지막 체크포인트 |
| rating | text | `up` / `down` |
| reason | text | 👎 사유: `wrong`(틀린 내용) / `irrelevant`(관련 없는 문서) / `code`(코드 오류) / `other`. 👎일 때만 |
| comment | text | 자유 입력 (최대 500자). 👎일 때만 |
| created_at, updated_at | timestamptz | 처음 저장·마지막 갱신 시각 |

- 기본 키 `(thread_id, checkpoint_id)`
- 체크포인트 테이블은 패키지가 관리하므로 외래 키를 두지 않는다. 대신 `POST /api/feedback`이 같은 문장 안에서 체크포인트가 있는지 확인한 뒤 저장한다.

### 생성

체크포인트와 같은 절차로, DB의 CREATE 권한을 임시로 주고 `checkpoint_user`가 스키마와 테이블을 만든다. 소유자 계정이 `CREATE SCHEMA ... AUTHORIZATION checkpoint_user`로 직접 만들 수는 없다 (PostgreSQL 16부터 대상 역할로 `SET ROLE`할 수 있어야 하며, `neondb_owner`는 `checkpoint_user`의 멤버가 아님).

```sql
-- 1. Neon SQL Editor (neondb_owner)
GRANT CREATE ON DATABASE neondb TO checkpoint_user;

-- 2. pnpm --filter scripts setup-feedback  (스키마·테이블 생성)

-- 3. Neon SQL Editor (neondb_owner)
REVOKE CREATE ON DATABASE neondb FROM checkpoint_user;
```

### 보관과 활용

- `cleanup-threads -- --delete`가 대화를 지울 때 그 대화의 피드백도 함께 지운다. 체크포인트가 없으면 질문과 출처를 알 수 없기 때문이다.
- `pnpm --filter scripts feedback-export`가 👎 피드백을 질문·검색어·출처·답변과 함께 평가셋 후보 JSON으로 출력한다.
