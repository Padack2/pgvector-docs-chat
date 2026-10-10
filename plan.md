# pgvector-docs-chat 프로젝트 계획

## 개요
LangChain 공식 문서(JS/TS)를 LangGraph 기반 RAG 챗봇으로 검색하는 포트폴리오 프로젝트

## 기술 스택
- Next.js (App Router) — 프론트 + API Routes
- LangGraph + LangChain — AI 워크플로우
- Gemini 3.8 Flash — LLM (로컬 개발 시 `LLM_PROVIDER=ollama`로 Ollama 전환 가능)
- Gemini Embedding API (`gemini-embedding-001`, 1536차원) — 텍스트 임베딩
- PostgreSQL + pgvector — 벡터 저장 및 유사도 검색 (Neon 호스팅)
- Vercel — 배포

## 데이터 소스
- LangChain 공식 문서 TypeScript 섹션: langchain, langgraph, deepagents, concepts (141페이지, 약 400만 자)
- 인덱스: https://docs.langchain.com/_llms/agent-development-lifecycle/build/type-script.md (페이지별 `.md` 원본 제공)
- 크롤링 → 청킹 → 임베딩 → pgvector 저장

## LangGraph 워크플로우
1. **의도 분류 노드**: 문서 검색이 필요한 질문인지 판단
2. **RAG 검색 노드**: pgvector 유사도 검색으로 관련 청크 추출
3. **품질 판단 노드**: 검색 결과가 충분한지 평가
4. **재검색 루프**: 불충분하면 쿼리 재작성 후 재검색 (최대 3회)
5. **답변 생성 노드**: 검색 결과 기반 최종 답변 생성

## Phase 1 — 데이터 파이프라인
- [x] Neon 프로젝트 생성 및 pgvector 확장 활성화
- [x] 문서 크롤링 스크립트 작성
- [x] 청킹 전략 결정: MDX 정리 → 헤딩 단위 섹션 → 1500자/150 overlap 분할, 청크 앞에 `제목 > 섹션` 경로 부착 (`scripts/chunk.ts`)
- [x] Gemini Embedding API로 임베딩 생성
- [x] pgvector 테이블에 저장 (바뀐 페이지만 재임베딩, [ADR-002](docs/adr/ADR-002-incremental-sync.md))

## Phase 2 — LangGraph 워크플로우
- [x] LangGraph 노드 설계 및 구현
- [x] 의도 분류 로직
- [x] RAG 검색 노드
- [x] 재검색 루프 (Self-RAG 패턴)
- [x] 답변 생성 노드

## Phase 3 — Next.js 챗봇 UI
- [x] 채팅 UI 구현
- [x] 스트리밍 응답 처리
- [x] 참조 문서 출처 표시
- [x] Vercel 배포

## Phase 4 — 검색 품질 평가
- [x] 평가셋 50문항 (`scripts/eval/questions.json`): 섹션 단위 정답, 한/영, 상황 설명·API 이름·에러 메시지 유형
- [x] 평가 스크립트 (`pnpm --filter scripts eval`): Hit@k·MRR, 질문 임베딩 캐시로 재실행 시 API 호출 없음
- [x] 베이스라인 (벡터 검색, 2026-10-09): Hit@1 78% / Hit@5 98% / MRR 0.858 — 상위 5개 밖은 희귀 식별자 에러 질문 1건(`ContextOverflowError`)
- [ ] 실사용 질문 추가 (현재 질문·정답을 모두 Claude가 작성해 편향 가능)
- [x] 평가 결과를 보고 다음 개선 방향 결정: 검색은 충분(Hit@5 98%) → 하이브리드 검색 보류, LangGraph 기능 확장(Phase 5~7)으로 방향 결정

## Phase 5 — 대화 저장과 분기 (checkpointer, time travel)
목표: 대화를 서버에 스레드로 저장하고, 이전 질문을 수정하면 그 시점부터 대화가 갈라지게 한다. Phase 6(interrupt)의 전제 조건.

설계
- 지금은 클라이언트가 매 요청에 대화 전체를 보낸다 → `threadId` + 새 메시지만 보내고, 기록은 checkpointer가 가진다
- `@langchain/langgraph-checkpoint-postgres`의 `PostgresSaver`를 Neon에 연결. 챗봇 계정(`DATABASE_URL`)은 읽기 전용이므로 checkpoint 테이블에만 쓸 수 있는 계정을 따로 둔다 (문서 테이블 쓰기 권한은 주지 않음)
- 분기는 `getStateHistory`로 수정할 질문 직전 체크포인트를 찾고 `checkpoint_id`를 지정해 다시 실행(fork). 공식 프론트엔드 SDK(`useStream`)는 Agent Server(유료 플랜) 또는 분기 기능이 없는 커스텀 전송만 가능해 쓰지 않고 route에서 직접 구현 ([ADR-005](docs/adr/ADR-005-conversation-persistence.md))
- 서버리스라 `PostgresSaver.setup()`(테이블 생성)은 요청마다 하지 않고 스크립트로 한 번 실행

작업
- [x] `@langchain/langgraph-checkpoint-postgres` 설치, langgraph 1.4.x와 버전 호환 확인 — 1.0.6은 채널 버전을 정수로 매겨 분기 간 blob이 충돌하므로 `getNextVersion` 재정의 (`checkpointer.ts`)
- [x] Neon에 checkpoint 전용 스키마·계정 생성, `CHECKPOINT_DATABASE_URL` 추가 (.env.example, Vercel) → 확인: 이 계정으로 `doc_chunks` 쓰기가 거부되는지
- [x] `scripts/setup-checkpointer.ts`로 테이블 생성
- [x] `graph.compile({ checkpointer })`, route 요청 형식을 `{ threadId, message }`로 변경 → 확인: 같은 threadId로 두 번 질문하면 두 번째 답이 첫 대화를 이어받는지 (후속 질문 "그거 예시는?")
- [x] `GET /api/threads/[id]`: 저장된 대화 불러오기, 클라이언트는 URL(`?thread=`)에 threadId 유지 → 확인: 새로고침·링크 공유 후 대화가 그대로 보이는지
- [x] 재시도를 체크포인트 기준으로 변경 (실패한 실행 직전 체크포인트에서 다시 실행) → 확인: 실패 후 재시도해도 대화 기록에 실패한 턴이 남지 않는지
- [x] 메시지 수정 → fork, 같은 위치의 분기를 `< 1/2 >`로 전환하는 UI → 확인: 분기를 오가도 각 분기의 이후 대화가 유지되는지
- [x] 오래된 스레드 정리 방침 (체크포인트는 매 단계 쌓여 무한히 커짐): 보관 기간을 정하고 정리 스크립트 작성: 30일, `scripts/cleanup-threads.ts`
- [x] README·schema.md 갱신, threadId(UUID)를 아는 사람은 대화를 볼 수 있다는 점 명시

## Phase 6 — 애매한 질문 되묻기 (interrupt)
목표: 질문이 LangChain / LangGraph / Deep Agents 중 어느 것에 대한 것인지 애매하면 그래프를 멈추고 선택지를 보여준 뒤, 고른 값으로 이어서 실행한다.

설계
- 같은 주제가 세 프레임워크 문서에 겹쳐 있다 (streaming, memory, human-in-the-loop, subagents 등 — 평가셋에서도 정답 페이지가 여러 곳)
- classify 출력에 "대상 프레임워크"(하나로 특정 / 애매)를 추가하고, 애매하면 별도 `clarify` 노드에서 `interrupt({ question, options })`. 재개 시 노드가 처음부터 다시 실행되므로 interrupt 앞에 부수 효과를 두지 않는다
- 고른 프레임워크로 검색 범위를 제한 (`source_url` 경로로 pgvector 쿼리에 메타데이터 필터) → 검색어만 바꾸는 것보다 확실하게 좁힘
- route: updates 스트림의 `__interrupt__`를 `{"type":"interrupt", question, options}` 이벤트로 전달, 재개 요청은 `new Command({ resume })`로 같은 스레드에서 실행
- LLM 호출 수는 그대로 (분류 출력 필드만 추가)

작업
- [x] classify 스키마에 대상 프레임워크 필드 추가, 프롬프트에 "명확하면 묻지 않는다" 기준 명시
- [x] `clarify` 노드 + 그래프 분기 (classify → clarify → retrieve)
- [x] `searchChunks`에 프레임워크 필터 추가 (`source_url LIKE` 경로 조건) → 확인: 필터 적용 시 다른 프레임워크 청크가 나오지 않는지 — HNSW 사후 필터로 결과가 모자라지 않게 필터 검색에서만 iterative scan 사용
- [x] route에 interrupt 이벤트·resume 요청 처리
- [x] UI: 선택지 버튼 + 직접 입력, 처리 과정에 "되물음 · LangGraph 선택" 단계 표시 → 확인: 새로고침 후에도 멈춘 질문이 다시 보이고 이어서 답할 수 있는지 (Phase 5 체크포인트) — 직접 입력은 프레임워크로 바꾸는 데 LLM 호출이 더 들어 빼고 "구분 없이 찾기" 선택지로 대신함. 선택하지 않고 새 질문을 보내면 멈춘 질문을 대체
- [x] 되묻기 판단 평가: 애매한 질문·명확한 질문 각 10개로 "물어야 할 때 묻고, 안 물어야 할 때 안 묻는지" 측정 (LLM 호출이 필요하므로 Ollama 또는 한도 안에서 실행) — 23문항(후속 질문 3 포함), gemini-3.5-flash-lite 20/23 (recall 7/10, precision 7/7), qwen2.5:7b 14/23 (recall 1/10). 3.8-flash는 한도 소진으로 미측정

## Phase 7 — 복합 질문 분해와 병렬 검색 (Send, 서브그래프)
목표: "checkpointer와 store는 뭐가 다르고 각각 언제 써?"처럼 여러 주제를 묻는 질문을 하위 질문으로 나눠 동시에 검색하고, 합쳐서 답한다.

설계
- 지금의 retrieve → grade → rewrite 반복을 하위 질문 하나를 조사하는 서브그래프로 분리하고, 단일 질문도 같은 서브그래프를 1번 실행 (코드 경로 하나)
- classify가 출력 필드로 하위 질문 1~3개를 함께 만들고 (별도 노드는 LLM 호출이 늘어 제외, ADR-007), `Send`로 서브그래프를 하위 질문 수만큼 병렬 실행
- 각 분기 결과는 reducer로 합치고 중복 청크를 제거, 답변 컨텍스트는 상한(예: 8청크)을 둠. 인용 번호는 합친 순서 기준
- 처리 과정 UI는 `subgraphs: true` 스트림의 namespace로 분기별 단계를 구분해 표시
- 하위 질문마다 grade 호출이 생겨 LLM 호출이 가장 많이 늘어남 → 하위 질문 최대 3개, 분당 한도는 모델 자동 전환(Phase 4 이후 llm.ts)에 의존

작업
- [x] 평가셋에 비교·복합 질문 10개 추가 (하위 주제별 정답 섹션), 지표: 모든 하위 주제의 정답 섹션이 답변 컨텍스트에 들어간 비율 → 분해 전 베이스라인 먼저 측정 — `scripts/eval-compound.ts`, 검색 단계만 비교(grade·rewrite 제외). 기준선 2/10, 하위 주제 12/20 (2회 동일). 상위 10개·MMR·섹션 중복 제거로는 최대 4/10이라 분해로 결정, 분해는 classify 출력 필드로 해 LLM 호출 수 유지 ([ADR-007](docs/adr/ADR-007-compound-question-retrieval.md))
- [ ] 검색 반복 구간을 서브그래프로 분리 → 확인: 기존 평가 결과(Hit@5 98%)와 단일 질문 동작이 그대로인지
- [ ] 질문 분해 출력 + `Send` 병렬 실행 + 결과 병합 reducer
- [ ] 처리 과정 UI에 분기별 단계 표시
- [ ] 분해 전후 비교 평가, README에 결과 추가 → 확인: 복합 질문 지표가 오르고 단일 질문 지표는 떨어지지 않는지

## DB 스키마
```sql
-- pgvector 확장 활성화
CREATE EXTENSION IF NOT EXISTS vector;

-- 문서 청크 저장
CREATE TABLE doc_chunks (
  id          BIGSERIAL PRIMARY KEY,
  content     TEXT NOT NULL,
  embedding   VECTOR(1536),
  source_url  TEXT,
  title       TEXT,
  chunk_index INT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 벡터 유사도 검색 인덱스 (HNSW)
CREATE INDEX ON doc_chunks
  USING hnsw (embedding vector_cosine_ops);
```

## 폴더 구조
pgvector-docs-chat/
├── apps/
│ └── web/ # Next.js 앱
│ ├── src/
│ │ ├── app/
│ │ │ ├── page.tsx # 챗봇 UI
│ │ │ └── api/
│ │ │ └── chat/
│ │ │ └── route.ts # LangGraph 호출
│ │ └── lib/
│ │ ├── graph/ # LangGraph 노드 정의
│ │ │ ├── index.ts # 그래프 진입점
│ │ │ ├── nodes/
│ │ │ │ ├── classify.ts # 의도 분류
│ │ │ │ ├── retrieve.ts # RAG 검색
│ │ │ │ ├── grade.ts # 품질 판단
│ │ │ │ └── generate.ts # 답변 생성
│ │ │ └── state.ts # 그래프 상태 정의
│ │ └── db/
│ │ └── pgvector.ts # Neon 연결 + 검색
│ ├── .env.example
│ └── package.json
├── scripts/
│ ├── crawl.ts # 문서 크롤링
│ ├── chunk.ts # 청킹
│ └── embed.ts # 임베딩 + DB 저장
├── docs/
│ └── schema.md # DB 스키마 정의서
├── package.json # pnpm workspace root
├── pnpm-workspace.yaml
├── plan.md
└── README.md

## 참고
- [LangGraph 공식 문서](https://langchain-ai.github.io/langgraphjs/)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [Neon pgvector 가이드](https://neon.com/docs/extensions/pgvector)