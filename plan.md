# pgvector-docs-chat 프로젝트 계획

LangChain 공식 문서(JS/TS)를 LangGraph 기반 RAG 챗봇으로 검색하는 포트폴리오 프로젝트입니다.
결정 근거는 [docs/adr](docs/adr/), 평가 결과는 [README](README.md#검색-품질-평가), DB 구조는 [docs/schema.md](docs/schema.md)에 정리합니다.

## 진행 현황

| Phase | 내용 | 상태 | 핵심 결과 |
| --- | --- | :---: | --- |
| 1 | 데이터 파이프라인 | ✅ | 141페이지 → 3,049청크, 바뀐 페이지만 재임베딩 |
| 2 | LangGraph 워크플로우 | ✅ | 분류 → 검색 → 품질 판단 → 재검색 루프 → 답변 |
| 3 | 챗봇 UI·배포 | ✅ | 스트리밍, 출처 표시, Vercel 배포 |
| 4 | 검색 품질 평가 | ✅ | Hit@5 98%, MRR 0.858 (50문항) |
| 5 | 대화 저장과 분기 | ✅ | PostgresSaver, 질문 수정 시 분기(fork) |
| 6 | 애매한 질문 되묻기 | ✅ | interrupt + 프레임워크 필터 검색 |
| 7 | 복합 질문 분해·병렬 검색 | ✅ | 복합 질문 2~3/10 → 8/10, 단일 질문 43 → 49/50 |
| 8 | 답변 코드 검증 | ⬜ | |
| 9 | 사용자 피드백 수집 | ⬜ | |
| 10 | 문서 변경 추적 | ⬜ | |

### 남은 작업 (Phase 7 후속)

- [x] classify 검색어 규칙 수정(사용자 표현 유지, 근거 없는 프레임워크 이름 추가 금지): 단일 질문 44·45 → 49/50, 복합 질문 8/10 유지, 되묻기 recall 21·22/22·precision 21/23·22/24 ([ADR-008](docs/adr/ADR-008-search-query-keeps-user-wording.md))
- [ ] 단일 질문의 그래프 경유 LLM 호출 증가량 측정 (`eval-compound --graph --single`, ADR-007 TODO) → 세부 측면 분할 억제 여부 판단

## 기술 스택

- **앱**: Next.js 14 (App Router), Vercel 배포
- **워크플로우**: LangGraph + LangChain (JS)
- **LLM**: Gemini 3.8 Flash, 실패 시 3.5 Flash → 3.1 Flash Lite 순으로 자동 전환 ([ADR-003](docs/adr/ADR-003-llm-model-fallback.md)). 로컬 개발 시 `LLM_PROVIDER=ollama`로 전환 가능
- **임베딩**: `gemini-embedding-001` (1536차원)
- **DB**: Neon PostgreSQL + pgvector (HNSW), 대화 체크포인트는 `langgraph` 스키마

## LangGraph 워크플로우

```
classify ─┬─ (잡담) ───────────────────────────────────────────▶ generate
          ├─ (애매함) ▶ clarify [interrupt] ─┐
          └──────────────────────────────────┴▶ research × N ─▶ generate
                                                (Send 병렬)

research 서브그래프 (하위 질문 1개):  retrieve ▶ grade ─(부족)▶ rewrite ▶ retrieve … (최대 3회)
```

- **classify**: 검색 필요 여부, 독립 검색어, 하위 질문 1~3개, 프레임워크 후보를 LLM 호출 1회로 출력
- **clarify**: 프레임워크가 애매하면 그래프를 멈추고 선택지를 보여준 뒤, 고른 값으로 검색 범위를 제한
- **research**: 하위 질문마다 병렬 실행되며, 결과는 순위별 교차 병합·섹션 중복 제거 후 8청크로 제한
- **generate**: 병합한 청크를 근거로 인용 번호를 붙여 답변

---

## 완료된 Phase

<details>
<summary><b>Phase 1~4</b> — 데이터 파이프라인, 워크플로우, UI, 검색 평가</summary>

- **데이터**: MDX 정리 → 헤딩 단위 섹션 → 1500자/150 overlap 분할, 청크 앞에 `제목 > 섹션` 경로 부착. 청크 본문 비교로 바뀐 페이지만 재임베딩 ([ADR-001](docs/adr/ADR-001-embedding-model.md), [ADR-002](docs/adr/ADR-002-incremental-sync.md))
- **워크플로우·UI**: 의도 분류, 검색, 재검색 루프(Self-RAG), 스트리밍 답변, 출처 표시, Vercel 배포
- **평가**: 섹션 단위 정답 50문항(한/영, 상황 설명·API 이름·에러 메시지). 벡터 검색 기준 Hit@1 78% / Hit@5 98% / MRR 0.858
- **결론**: 검색 품질은 충분하므로 하이브리드 검색은 보류하고 LangGraph 기능 확장으로 방향 결정 ([ADR-004](docs/adr/ADR-004-hybrid-search-deferred.md))
- 미완료: 실사용 질문 추가 → Phase 9로 이관

</details>

<details>
<summary><b>Phase 5</b> — 대화 저장과 분기 (checkpointer, time travel)</summary>

- 요청 형식을 `{ threadId, message }`로 바꾸고, 대화 기록은 `PostgresSaver`가 보관 ([ADR-005](docs/adr/ADR-005-conversation-persistence.md))
- checkpoint 전용 스키마·계정 분리 (문서 테이블 쓰기 권한 없음), 테이블 생성은 `setup-checkpointer` 스크립트로 1회 실행
- 질문 수정 시 직전 체크포인트에서 다시 실행(fork), 같은 위치의 분기를 `< 1/2 >`로 전환
- JS PostgresSaver가 분기 간 채널 버전이 겹치는 문제는 `getNextVersion` 재정의로 해결
- 30일 넘게 활동이 없는 대화 정리 스크립트 (`cleanup-threads`)

</details>

<details>
<summary><b>Phase 6</b> — 애매한 질문 되묻기 (interrupt)</summary>

- classify가 프레임워크 후보를 함께 출력하고, 2개 이상이면 `clarify` 노드에서 `interrupt` ([ADR-006](docs/adr/ADR-006-framework-clarification.md))
- 고른 프레임워크로 `source_url` 경로 필터 검색 (필터 검색에서만 HNSW iterative scan)
- 새로고침 후에도 멈춘 질문을 다시 보여주고 이어서 답할 수 있음
- 되묻기 판단 평가 49문항: recall 19/22, precision 100% (3.1-flash-lite). 이후 검색어 규칙 수정으로 recall 21·22/22, precision 21/23·22/24 (ADR-008)

</details>

<details>
<summary><b>Phase 7</b> — 복합 질문 분해와 병렬 검색 (Send, 서브그래프)</summary>

- 검색 반복 구간을 `research` 서브그래프로 분리하고, 하위 질문마다 `Send`로 병렬 실행 ([ADR-007](docs/adr/ADR-007-compound-question-retrieval.md))
- 하위 질문은 별도 노드 없이 classify 출력 필드로 생성해 LLM 호출 수 유지
- 처리 과정 목록·그래프 패널에 하위 질문별 진행 단계 표시
- 결과: 복합 질문 2~3/10 → 8/10 (그래프 경유 3회), 단일 질문 43/50 → 44·45/50

</details>

---

## Phase 8 — 답변 코드 검증

**목표**: 답변에 들어간 TypeScript 코드를 실제 `@langchain/*` 타입 정의로 타입 검사하여, 존재하지 않는 API나 잘못된 시그니처를 LLM 판단이 아닌 컴파일러로 걸러낸다.

**설계**
- generate 뒤에 `verify` 노드 추가: 답변의 ` ```ts ` 코드 블록을 추출해 TS 컴파일러 API(`typescript` 5.x, 메모리 내 가상 파일 시스템)로 타입 검사
- 문서 예시 코드는 일부만 발췌된 경우가 많으므로 **LangChain 패키지 API 관련 에러만** 판정 대상으로 삼는다 (예: TS2305 export 없음, TS2339 속성 없음, TS2345·TS2554 인자 불일치). 선언되지 않은 변수(TS2304) 등은 무시
- 실패 시 `fix` 노드가 컴파일러 에러 메시지를 근거로 해당 코드 블록만 다시 생성 → 재검사 (최대 1회). 답변은 이미 스트리밍됐으므로 수정본은 답변 아래 "수정된 코드" 블록으로 덧붙인다
- 타입 정의는 빌드 시 스크립트로 필요한 `.d.ts`만 모아 번들에 포함 (Vercel 함수 크기·콜드 스타트 고려)
- LLM 호출은 검증 실패 시에만 1회 증가

**작업**
- [ ] 사전 검증: Vercel 함수에서 TS 컴파일러 + `.d.ts` 번들로 타입 검사가 가능한지, 번들 크기·첫 실행 시간 측정 → 불가하면 대안(빌드 시 미리 만든 API 목록과 대조) 검토
  - 로컬 측정 (2026-10-16, typescript 5.9.3, 문서 예시 1,076블록): 필요한 `.d.ts` 1,081개·12.3MB + `typescript.js` 8.7MB, 첫 검사 1.3초, 이후 중앙값 42ms·p95 388ms → 크기·시간은 여유 있음. Vercel 실측은 미완료 (`.d.ts`는 JS 의존성 추적에 잡히지 않으므로 함수 번들에 명시적으로 포함해야 함)
  - 공식 문서 예시 자체의 15%(160/1,076블록, 35페이지)가 API 관련 에러로 판정됨. 문서가 옛 API를 쓰는 경우(`MemoryStore` → `InMemoryStore`)와 문서·타입 정의가 어긋나는 경우가 섞여 있음 → 문서를 근거로 한 답변이 검증에서 실패할 수 있으므로 처리 방침 결정 필요
- [ ] 코드 블록 추출 + 타입 검사 모듈, 판정 대상 에러 코드 목록 → 확인: 문서 원본 예시 코드 샘플이 오탐 없이 통과하는지
- [ ] `verify` → `fix` 노드와 그래프 분기, route 이벤트(`{"type":"verify", ok, errors}`)
- [ ] UI: 답변 아래 "코드 검증됨 ✓" / 에러 내용과 수정된 코드 표시, 그래프 패널에 노드 추가
- [ ] 평가: 평가셋 일부(약 20문항)를 그래프 경유로 실행해 답변 코드의 API 에러 비율을 검증 전후로 비교 → README·ADR 기록

## Phase 9 — 사용자 피드백 수집

**목표**: 답변마다 👍/👎와 사유를 받아 저장하고, 👎 질문을 평가셋 후보로 모아 Phase 4의 "실사용 질문 추가" 과제를 해결한다.

**설계**
- 피드백은 `(thread_id, checkpoint_id)` 단위로 1건 (다시 누르면 갱신). 질문·검색어·출처 등 평가셋 작성에 필요한 정보는 체크포인트에서 조회하므로 피드백 테이블에는 저장하지 않는다
- 저장 위치와 계정: 문서 테이블과 권한을 분리하는 기존 원칙에 따라 피드백 전용 테이블을 두고, 쓰기 권한 부여 범위를 결정한다 (checkpoint 계정 재사용 여부 → 결정 시 ADR)
- 공개 엔드포인트이므로 존재하는 스레드·체크포인트에 대해서만 저장하고, 사유는 길이를 제한한다

**작업**
- [ ] 피드백 테이블·권한 생성, schema.md 갱신
- [ ] `POST /api/feedback` (thread_id·checkpoint_id 존재 확인, 사유 길이 제한)
- [ ] UI: 답변 하단 👍/👎, 👎 선택 시 사유 선택지(틀린 내용 / 관련 없는 문서 / 코드 오류 / 기타)와 입력란 → 확인: 새로고침 후에도 선택 상태 유지
- [ ] `pnpm --filter scripts feedback-export`: 👎 질문을 질문·검색어·출처와 함께 평가셋 후보 JSON으로 출력
- [ ] 수집된 실사용 질문으로 평가셋 보강, 기존 평가 결과와 비교 → README 기록

## Phase 10 — 문서 변경 추적

**목표**: 증분 동기화(ADR-002)를 주기적으로 실행하고, 바뀐 문서를 요약해 보여준다. 이전 대화가 인용한 문서가 이후 바뀌었으면 해당 대화에 표시한다.

**설계**
- 크롤링 → 청킹 → 임베딩 파이프라인은 실행 시간이 길어 Vercel Cron 대신 **GitHub Actions 예약 실행**(주 1회)으로 돌린다. DB 접속 정보는 Actions secret으로 관리
- 동기화 시 페이지별 추가·변경·삭제 내역과 변경 섹션을 변경 이력 테이블에 기록 (기존 비교 로직 재사용, ADR-002의 비목표 "자동 갱신"을 변경하므로 ADR 갱신 또는 신규 작성)
- 변경 요약은 페이지당 LLM 1회, 1회 실행당 요약 페이지 수 상한을 두어 무료 한도 안에서 처리. 임베딩 일일 한도(약 1,000건)를 넘는 변경은 다음 실행에서 이어서 처리
- 이전 대화의 출처 URL과 변경 이력의 페이지·시각을 비교해 "인용 문서가 이후 변경됨" 표시

**작업**
- [ ] 변경 이력 테이블 설계, `embed` 스크립트가 변경 내역을 기록하도록 수정 → 확인: 변경 없는 재실행에서 이력이 생기지 않는지
- [ ] GitHub Actions 워크플로우 (예약 + 수동 실행), 실패 시 다음 실행에서 이어지는지 확인
- [ ] 변경 요약 생성 (페이지당 LLM 1회, 상한 적용)
- [ ] UI: "최근 문서 변경" 목록 페이지, 대화의 출처 옆 "이후 변경됨" 표시
- [ ] README·schema.md·ADR 갱신

## 참고

- [LangGraph.js 문서](https://langchain-ai.github.io/langgraphjs/)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [Neon pgvector 가이드](https://neon.com/docs/extensions/pgvector)
