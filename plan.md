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
| 8 | 답변 코드 검증 | ✅ | 코드 답변 20/20 중 판정 에러 2건, 모두 문서 예시에서 비롯됨. 운영 첫 요청 34.6초 (60초 제한 안) |
| 9 | 사용자 피드백 수집 | 🔶 | 수집 기능 완료, 실사용 👎이 쌓이면 평가셋 보강 |
| 10 | 문서 변경 추적 | ✅ | 주간 Actions 동기화, 변경 이력 34건(변경 30·추가 1·삭제 3) 요약, 출처 "이후 변경됨" 표시 |
| 11 | 프레임워크 선호 기억 | ✅ | 익명 쿠키 + PostgresStore로 되묻기 선택을 다음 대화에 적용, "변경"으로 되묻기 |

### 남은 작업 (Phase 7 후속)

- [x] classify 검색어 규칙 수정(사용자 표현 유지, 근거 없는 프레임워크 이름 추가 금지): 단일 질문 44·45 → 49/50, 복합 질문 8/10 유지, 되묻기 recall 21·22/22·precision 21/23·22/24 ([ADR-008](docs/adr/ADR-008-search-query-keeps-user-wording.md))
- [x] 단일 질문의 그래프 경유 LLM 호출 증가량 측정 (`eval-compound --graph --single`, ADR-007 TODO) → 세부 측면 분할 억제 여부 판단
  - 2026-10-21 lite 고정 1회: 그래프 경유 48/50(기준선 47), 분할 15/50(프레임워크별 2·세부 측면 13), LLM 질문당 약 2.4회(실패 재시도 제외, 기록상 2.6회), 분할로 인한 grade 증가 약 15%·정답 누락 없음 → 억제하지 않음 ([ADR-007](docs/adr/ADR-007-compound-question-retrieval.md) 검증 절)

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

**목표**: 답변에 들어간 TypeScript 코드를 실제 `@langchain/*` 타입 정의로 타입 검사하여, 존재하지 않는 API나 잘못된 시그니처를 LLM 판단이 아닌 컴파일러로 찾아내 경고한다.

**설계**
- generate 뒤에 `verify` 노드 추가: 답변의 ` ```ts ` 코드 블록을 추출해 TS 컴파일러 API(`typescript` 5.x, 메모리 내 가상 파일 시스템)로 타입 검사
- 문서 예시 코드는 일부만 발췌된 경우가 많으므로 **LangChain 패키지 API 관련 에러만** 판정 대상으로 삼는다 (예: TS2305 export 없음, TS2339 속성 없음, TS2345·TS2554 인자 불일치). 선언되지 않은 변수(TS2304) 등은 무시
- 답변 코드의 에러를 에러 코드 + 식별자(예: TS2724 + `MemoryStore`)로 출처 문서 예시의 에러와 비교한다. 출처 비교는 페이지 단위로 미리 계산한 에러 목록(`source-errors.json`)으로 한다 (청크는 코드 블록이 잘려 있어 2026-10-18 변경, ADR-009)
- 자동 수정은 하지 않고 답변 아래에 경고만 표시한다. 출처에도 같은 에러가 있으면 "참고한 문서 예시도 현재 패키지 타입과 맞지 않음(문서가 옛 API일 수 있음)", 없으면 "문서에 없는 API(답변이 잘못 만든 코드일 수 있음)"로 구분한다
- 타입 정의는 빌드 시 스크립트로 필요한 `.d.ts`만 모아 번들에 포함 (Vercel 함수 크기·콜드 스타트 고려)
- LLM 호출 증가 없음. "출처에 없음" 비율을 측정한 뒤, 근거가 있을 때만 해당 경우에 한정한 `fix` 노드 추가를 검토한다

**작업**
- [x] 사전 검증: Vercel 함수에서 TS 컴파일러 + `.d.ts` 번들로 타입 검사가 가능한지, 번들 크기·첫 실행 시간 측정 → 불가하면 대안(빌드 시 미리 만든 API 목록과 대조) 검토
  - 로컬 측정 (2026-10-16, typescript 5.9.3, 문서 예시 1,076블록): 필요한 `.d.ts` 1,081개·12.3MB + `typescript.js` 8.7MB, 첫 검사 1.3초, 이후 중앙값 42ms·p95 388ms
  - Vercel 프리뷰 실측 (2026-10-17, 예시 3개): 빌드 전 스크립트로 `.d.ts`를 한 폴더에 복사하고 `outputFileTracingIncludes`로 함수에 포함 (29패키지·2,631파일, 함수 추적 파일 합계 26.5MB). 콜드 요청 TTFB 4.69초(첫 검사 2.4초 포함), 이후 검사 79~559ms. 옛 API 예시의 TS2724 검출 확인 → 타입 검사 방식으로 진행, 대안 불필요
  - 공식 문서 예시 자체의 15%(160/1,076블록, 35페이지)가 API 관련 에러로 판정됨. 문서가 옛 API를 쓰는 경우(`MemoryStore` → `InMemoryStore`)와 문서·타입 정의가 어긋나는 경우가 섞여 있음 → 검증 결과는 자동 수정하지 않고 경고로만 표시하기로 결정 (2026-10-17)
- [x] 코드 블록 추출 + 타입 검사 모듈, 판정 대상 에러 코드 목록, 출처 코드와의 에러 비교 → 확인: 문서 원본 예시 코드 샘플에서 발췌로 생기는 에러(TS2304 등)가 판정에서 빠지는지
  - `apps/web/src/lib/verify.ts`: 판정 대상은 에러 코드 10종(2305·2724·2614·2339·2551·2353·2345·2554·2769·2322) 중 선언 위치가 `@langchain/*`·`langchain`·`deepagents`인 API의 에러만. 출처 비교 키는 `에러 코드:API 이름`이며, 출처 코드는 답변에 에러가 있을 때만 검사한다. 타입 정의 대상에 `deepagents`·`@langchain/openai`·`@langchain/anthropic`을 devDependencies로 추가 (types-bundle 58패키지·25MB)
  - 문서 예시 1,873블록 측정 (2026-10-17, `pnpm --filter scripts verify-docs`): 판정 에러 블록 136개(7.3%)·36페이지. 제외된 에러는 TS2304 1,806건, TS2307 362건, TS1375 244건, TS7006 207건 등이며, 판정 대상 코드이지만 사용자 코드에서 난 에러 113건도 제외됨. 검사 시간 중앙값 127ms
  - 판정된 에러를 수동 확인한 결과 대부분 문서와 현재 타입 정의의 불일치였다 (예: deepagents `serverInfo`·`workingDirectory`·`temperature`, `createAgent`의 `prompt` → `systemPrompt`, `MemoryStore` → `InMemoryStore`, `AzureChatOpenAI`의 `azureOpenAIApiEndpoint`). 발췌 코드로 인한 오탐은 7건(인자가 `unknown`으로 추론된 경우, 일반 함수를 `tools`로 넘긴 경우, strict 모드의 `string | undefined`)으로 소수여서 별도 규칙은 두지 않음
- [x] `verify` 노드와 route 이벤트(`{"type":"verify", ok, errors}`, 에러마다 출처에도 있는지 여부 포함)
  - generate → verify → END. 검사 결과는 답변 메시지의 `additional_kwargs.verify`에 저장하고, 코드 블록이 없으면 메시지를 바꾸지 않고 이벤트도 보내지 않는다. 검사 중 예외가 나도 답변은 유지한다
  - 로컬 확인 (2026-10-18, dev 서버): InMemoryStore 예시 질문에서 TS2322(`search`, 출처에도 있음) 검출, createAgent 예시는 통과, 코드 없는 답변은 이벤트 없음. 따뜻한 상태의 검사는 1초 이내였으나, 서버 기동 직후 첫 요청은 전체 63초로 `maxDuration`(60초)을 넘었다(dev 컴파일과 /mnt/f의 첫 검사 포함). 타입 검사는 동기 실행이라 그래프 시간 제한(`AbortSignal`)으로 중단되지 않으므로, Vercel 배포 후 콜드 요청 시간을 확인해야 한다
  - Vercel 운영 측정 (2026-10-18, 배포 직후 3회): 배포 후 첫 요청은 응답 헤더까지 4.7초, 전체 34.6초. 코드 2블록 답변 요청은 verify 시작부터 결과까지 3.3초(통과), 전체 26.1초. 1회는 grade 단계의 모델 지연으로 그래프 시간 제한(50초)에 걸려 38초에 에러 종료. 측정한 요청은 모두 `maxDuration`(60초) 안에 끝났다. verify 이후 스트림 종료까지 약 2초가 더 걸리며, 함수 리전(iad1)과 DB 리전(ap-southeast-1)이 달라 체크포인트 저장이 느린 것으로 추정된다(미확인)
- [x] UI: 답변 아래 "코드 검증됨 ✓" / 에러 내용과 출처 여부에 따른 경고 표시, 그래프 패널에 노드 추가
  - 통과 시 한 줄 표시, 출처에 없는 에러는 경고 상자, 출처에도 있는 에러는 안내 상자로 구분하며 에러는 코드 블록 번호·행·에러 코드와 메시지 첫 줄만 표시한다. 검사 중에는 진행 문구를 표시하고(코드 블록이 있는 답변만), 저장된 대화를 다시 불러와도 검사 결과를 표시한다
  - generate는 step 이벤트가 없으므로 verify 시작을 generate 종료로 간주한다. 타입 검사가 이벤트 루프를 막아 verify 시작 이벤트가 결과와 함께 도착하던 문제는 검사 전 50ms 양보로 해소
  - 로컬 확인 (2026-10-18, dev 서버·3.1-flash-lite): 코드 답변 2건 통과 표시, 코드 없는 답변은 표시 없음, 경고 2종은 저장된 대화 응답에 에러를 주입해 화면 확인. 로컬에서 verify 진행 문구가 약 10초 표시되었고(/mnt/f 첫 검사), 출처 목록은 검사가 끝난 뒤에 표시된다
  - 출처 목록을 검사 결과보다 먼저 표시하도록 route가 generate 종료 직후 `sources`를 보내게 변경. 화면은 `sources` 대신 에러 없는 스트림 종료를 실행 완료로 판단한다 (코드 블록이 없으면 verify 종료 이벤트가 없음). 이벤트 순서를 흉내 낸 스트림으로 코드 있음·없음 두 경우의 화면 확인
- [x] 평가: 평가셋 일부(약 20문항)를 그래프 경유로 실행해 답변 코드 중 API 에러가 있는 비율과 그중 "출처에도 있음/없음" 비율을 측정하고, 출처 비교 분류가 맞는지 수동 확인 → README·ADR 기록
  - `pnpm --filter scripts eval-verify`: 검색 품질 평가셋 중 구현 방법을 묻는 20문항을 classify → research 병렬 → generate → 코드 검증 순서로 실행 (체크포인트 미사용)
  - 1차 측정 (2026-10-18, 3.1-flash-lite·503/429로 일부 다음 모델 전환): TS 코드가 있는 답변 20/20, 판정 에러가 있는 답변 2/20 (c30 `state.authenticated` TS2339, k12 `trimMessages`의 `tokenCounter` 누락 TS2345), 2건 모두 "출처에 없음"으로 분류. 검사 시간 중앙값 66ms, 질문당 LLM 호출 평균 4.8회
  - 수동 확인 결과 2건 모두 실제 에러이나 분류는 오류: 두 답변 모두 출처 문서 예시(context-engineering, add-memory)를 그대로 옮긴 코드이며 문서 예시에도 같은 에러가 있다. 원인은 청크 분할로 코드 블록이 청크 경계에서 잘려 출처 청크에서 코드 블록이 추출되지 않은 것 (전체 3,049청크 중 코드 펜스 수가 홀수인 청크 929개). 출처 비교 방식 수정 후 재측정 필요
  - 출처 비교를 페이지 단위로 변경: `verify-docs --write`가 문서 원본 전체 예시 코드의 판정 에러 키를 페이지별로 `apps/web/src/lib/source-errors.json`(36페이지)에 저장하고, `verifyAnswer`는 출처 URL로 조회한다 (런타임 출처 코드 검사 제거). 1차 측정의 같은 답변 20개를 다시 판정한 결과 2건 모두 "출처에도 있음"으로 수동 확인과 일치. "출처에 없음" 0건으로 `fix` 노드 도입 근거 없음 (표본 부족). ADR-009·README 기록

## Phase 9 — 사용자 피드백 수집

**목표**: 답변마다 👍/👎와 사유를 받아 저장하고, 👎 질문을 평가셋 후보로 모아 Phase 4의 "실사용 질문 추가" 과제를 해결한다.

**설계**
- 피드백은 `(thread_id, checkpoint_id)` 단위로 1건 (다시 누르면 갱신). 질문·검색어·출처 등 평가셋 작성에 필요한 정보는 체크포인트에서 조회하므로 피드백 테이블에는 저장하지 않는다
- 저장 위치와 계정: `checkpoint_user`가 소유한 별도 `feedback` 스키마 (2026-10-18 결정, [ADR-010](docs/adr/ADR-010-feedback-storage.md)). 피드백 식별자는 답변으로 끝난 턴의 마지막 체크포인트
- 공개 엔드포인트이므로 존재하는 스레드·체크포인트에 대해서만 저장하고, 사유는 길이를 제한한다

**작업**
- [x] 피드백 테이블·권한 생성, schema.md 갱신
  - `feedback.answer_feedback` (기본 키 `(thread_id, checkpoint_id)`, rating·reason·comment는 CHECK 제약). `CREATE SCHEMA ... AUTHORIZATION checkpoint_user`는 PostgreSQL 16의 `SET ROLE` 요건으로 실패해, 체크포인트와 같은 절차(DB CREATE 임시 부여 → `setup-feedback` → 회수)로 생성 (2026-10-18). `cleanup-threads`가 대화와 함께 피드백도 삭제
- [x] `POST /api/feedback` (thread_id·checkpoint_id 존재 확인, 사유 길이 제한)
  - 존재 확인과 upsert를 `INSERT ... SELECT ... WHERE EXISTS` 한 문장으로 처리. 확인: 없는 체크포인트 404, 허용되지 않은 사유·500자 초과 400
  - `GET /api/threads/[id]`가 답변마다 `checkpointId`(다음 턴 input 체크포인트의 부모, 마지막 턴이면 분기 끝)와 저장된 피드백을 반환. 답변 3개 대화에서 각 체크포인트 상태의 마지막 메시지가 해당 답변인지 확인
- [x] UI: 답변 하단 👍/👎, 👎 선택 시 사유 선택지(틀린 내용 / 관련 없는 문서 / 코드 오류 / 기타)와 입력란 → 확인: 새로고침 후에도 선택 상태 유지
  - 👎은 누르는 즉시 저장하고 사유를 보내면 갱신. 스트리밍 중에는 숨기고 대화를 다시 불러온 뒤 표시. 확인 (2026-10-18, 로컬): 👎+사유·👍 저장 후 새로고침해도 선택·사유·입력 내용 유지, 라이트·다크 화면 확인. 테스트 데이터는 삭제
- [x] `pnpm --filter scripts feedback-export`: 👎 질문을 질문·검색어·출처와 함께 평가셋 후보 JSON으로 출력
  - 체크포인트 상태에서 질문·검색어·하위 질문·출처·답변을 꺼낸다. 정리된 대화는 건너뜀
- [ ] 수집된 실사용 질문으로 평가셋 보강, 기존 평가 결과와 비교 → README 기록

## Phase 10 — 문서 변경 추적

**목표**: 증분 동기화(ADR-002)를 주기적으로 실행하고, 바뀐 문서를 요약해 보여준다. 이전 대화가 인용한 문서가 이후 바뀌었으면 해당 대화에 표시한다.

**설계**
- 크롤링 → 청킹 → 임베딩 파이프라인은 실행 시간이 길어 Vercel Cron 대신 **GitHub Actions 예약 실행**(주 1회)으로 돌린다. DB 접속 정보는 Actions secret으로 관리
- 동기화 시 페이지별 추가·변경·삭제 내역과 변경 섹션을 변경 이력 테이블에 기록 (기존 비교 로직 재사용, ADR-002의 비목표 "자동 갱신"을 변경하므로 ADR 갱신 또는 신규 작성)
- 변경 요약은 페이지당 LLM 1회, 1회 실행당 요약 페이지 수 상한을 두어 무료 한도 안에서 처리. 임베딩 일일 한도(약 1,000건)를 넘는 변경은 다음 실행에서 이어서 처리
- 이전 대화의 출처 URL과 변경 이력의 페이지·시각을 비교해 "인용 문서가 이후 변경됨" 표시

**작업**
- [x] 변경 이력 테이블 설계, `embed` 스크립트가 변경 내역을 기록하도록 수정 → 확인: 변경 없는 재실행에서 이력이 생기지 않는지
  - `doc_changes` (페이지·`added`/`changed`/`removed`·바뀐 섹션의 전/후 본문 `sections` jsonb·`synced_at`). 섹션은 청크 첫 줄의 섹션 경로로 묶어 비교. 청크 교체와 같은 트랜잭션에서 INSERT해 중단 후 재실행해도 이력이 중복·누락되지 않음. 변경 전 본문은 교체 후 사라지므로 작업 3의 요약 입력으로 이력에 저장 (2026-10-19 결정). 권한: `embed_user` SELECT·INSERT, `readonly_user` SELECT
  - 확인 (2026-10-19, 운영 DB): 변경 없는 재실행 `0 new/changed`·이력 0행 → 한 페이지(install) 섹션 임시 수정 시 1페이지 재임베딩·이력 1행(해당 섹션 전/후) → 원복 후 재실행으로 `doc_chunks` 복구, 이어서 재실행 시 이력 추가 없음. `added`·`removed` 경로는 실제 동기화에서 확인. 청킹 파라미터를 바꾸면 전 페이지가 `changed`로 기록됨(현재 대응 없음, 필요 시 이력 행 삭제)
- [x] GitHub Actions 워크플로우 (예약 + 수동 실행), 실패 시 다음 실행에서 이어지는지 확인
  - `.github/workflows/sync-docs.yml`: 매주 월요일 03:00 KST 예약 실행 + 수동 실행, crawl → chunk → embed. 임베딩 일일 한도를 챗봇 질문 임베딩과 공유하므로 1회 실행당 임베딩 상한 800청크(`MAX_EMBED_PER_RUN`)를 두고 나머지는 다음 실행으로 넘김. 분당 한도 429는 응답의 `retryDelay`가 0초여도 최소 60초 대기 후 재시도
  - 확인 (2026-10-19~20, 운영 DB): 1차 실행은 분당 한도 429 처리 결함으로 실패(삭제 3·변경 1 기록 후 중단) → 수정 후 2차 실행은 23/29페이지에서 일일 한도로 중단 → 3차 실행에서 남은 페이지와 신규 페이지(`concepts/human-in-the-loop`, 9청크)까지 완료. 이력 합계 `changed` 30·`added` 1·`removed` 3, 중단 후 재실행으로 인한 중복 기록 없음. `deepagents/customization`의 이력 2건은 10-19와 10-20 사이 실제 문서가 다시 변경된 것으로, 두 번째 이력의 변경 전 본문이 첫 번째 이력의 변경 후 본문과 일치함을 확인. 동기화 후 `doc_chunks` 3,047청크·139페이지
- [x] 변경 요약 생성 (페이지당 LLM 1회, 상한 적용)
  - `scripts/summarize-changes.ts`: `doc_changes.summary`가 NULL인 이력을 id 순으로 요약해 같은 행에 저장 (요약이 이력 행과 1:1이고, NULL이 미처리 표시를 겸해 중단 후 이어서 처리 가능). `removed`는 LLM 없이 고정 문구, `added`·`changed`는 바뀐 섹션의 전/후 본문을 `invokeChat`으로 1회 요약(기존 모델 자동 전환 재사용). 1회 실행당 LLM 요약 30페이지 상한. 섹션 하나가 3만 자를 넘는 경우가 있어 전/후 공통 앞뒤를 덜어내고 달라진 구간(앞뒤 300자 포함)만 넘기며, 3,000자를 넘으면 가운데를 생략
  - 권한: `embed_user`에 `summary` 열 UPDATE만 부여 (나머지 열은 INSERT 전용 유지). Actions에서는 embed 다음 단계로 실행하며, 챗봇 기본 모델의 한도를 쓰지 않도록 `GEMINI_MODEL=gemini-3.1-flash-lite` 지정. 요약 스크립트가 `apps/web`의 `llm.ts`를 쓰므로 설치 대상에 web 추가
  - 확인 (2026-10-20, 로컬 실행·운영 DB): 기존 이력 34행 중 `removed` 3행 고정 문구, LLM 요약 30행 후 상한 도달로 `added` 1행은 다음 실행으로 이월. 표본 대조 결과 `MemoryStore`→`InMemoryStore`, `crypto.randomUUID()`→`uuid7()`(`langsmith`/`uuid` 패키지 구분 포함), `UnsupportedContentMiddleware` 추가, `interruptMode: "per_call"`·`respond` 결정 유형 추가 등 실제 변경과 일치하며, 트레이스 링크만 추가·삭제된 페이지는 "문구·서식 수정"으로 요약됨. 로컬 실행은 `.env.local`의 모델 설정을 따르므로 lite 모델 기준 결과는 Actions 실행에서 확인
  - 확인 (2026-10-20, Actions 수동 실행): web 의존성 포함 설치 성공, 문서 변경 없음(이력 추가 0행), 이월된 `added` 1행(`concepts/human-in-the-loop`)을 lite 모델 설정으로 요약해 이력 34행 모두 요약 완료. 신규 페이지 요약은 페이지 개요(Per-call/Batched 검토 방식, `Command`·`resume` 처리)를 정리한 형태로 생성됨
- [x] UI: "최근 문서 변경" 목록 페이지, 대화의 출처 옆 "이후 변경됨" 표시
  - `/changes`: 최근 이력 100건을 동기화 날짜(KST)별로 표시 (추가·변경·삭제, 문서 링크, 요약). 요청마다 DB 조회(`force-dynamic`). 채팅 화면 헤더에 "문서 변경" 링크
  - 출처 표시: 저장된 대화를 불러올 때(`loadThread`) 답변 턴 마지막 체크포인트의 생성 시각 이후에 기록된 출처 페이지의 최근 이력을 붙여, 출처 옆에 "이후 변경됨"/"이후 삭제됨"을 표시하고 `/changes`의 해당 이력으로 연결(요약은 툴팁). 대화 1개당 조회 1회. 판정은 페이지 단위이므로 인용한 섹션이 아닌 다른 섹션만 바뀌어도 표시됨
  - 확인 (2026-10-20, 로컬): 10-19 동기화 이전 대화 30개 중 답변 있는 대화 대부분에서 변경된 출처(add-memory·persistence·agents·customization 등)만 표시되고 변경 없는 출처는 표시되지 않음. 배지 클릭 시 해당 이력으로 이동, 390px 폭에서 가로 스크롤 없음. 동기화 이후에 만든 대화가 없어 "변경 이후 답변은 표시 안 됨"은 실제 데이터로 확인하지 못함
  - 확인 (2026-10-21, 운영 Vercel): `/changes` 200, 이력 34건(추가 1·변경 30·삭제 3)과 요약 표시. 10-18 대화를 `GET /api/threads/[id]`로 불러온 결과 답변 2건에서 출처 `add-memory`만 "이후 변경됨"으로 표시되고 나머지 출처는 표시되지 않음
- [x] README·schema.md·ADR 갱신
  - ADR-011 신규(변경 이력에 섹션 전/후 본문 기록, 요약은 별도 단계). ADR-002는 비목표였던 자동 갱신을 ADR-011에서 도입했음을 연결. schema.md에 `doc_changes` 정의·권한(운영 DB의 열·제약·인덱스와 대조), README에 기능·파이프라인·운영 이슈·구조·명령 반영

## Phase 11 — 프레임워크 선호 기억

**목표**: 되묻기(clarify)에서 사용자가 고른 프레임워크를 LangGraph Store에 저장하고, 이후 다른 대화에서도 애매한 질문이면 되묻지 않고 기억된 프레임워크로 검색한다. 체크포인트(대화 단위 단기 기억)와 Store(사용자 단위 장기 기억)를 함께 사용한다.

**설계** (2026-10-22 결정)
- 사용자 식별: 로그인 없이 익명 ID를 사용한다. 첫 요청에서 서버가 UUID를 httpOnly 쿠키로 발급하고, route가 `configurable.user_id`로 그래프에 전달한다. Store namespace는 `["users", user_id]`, key는 `framework`. 로그인은 계속 비목표로 둔다 ([ADR-005](docs/adr/ADR-005-conversation-persistence.md))
- 기억 범위: 프레임워크 선호만 저장한다. 추가 LLM·임베딩 호출이 없으므로 Store 벡터 인덱스는 쓰지 않는다
- 저장소: `@langchain/langgraph-checkpoint-postgres`의 `PostgresStore`를 사용하고, `checkpoint_user`가 소유한 `langgraph` 스키마에 둔다. 테이블은 설치 스크립트로 한 번만 만들고 실행 중에는 `ensureTables: false`로 둔다
- 적용: clarify 노드가 interrupt 전에 Store를 조회한다. 기억된 프레임워크가 후보에 있으면 되묻지 않고 그 값을 적용하고, 후보에 없으면 지금처럼 되묻는다. 되묻기에서 특정 프레임워크를 고르면 저장하고, "구분 없이 찾기"를 고르면 기억을 지운다
- 표시: 기억을 적용한 답변에는 "기억된 선택: LangGraph · 변경"을 표시한다. "변경"을 누르면 질문 직전 체크포인트에서 분기해 기억을 적용하지 않고 다시 실행하며, 그 결과 되묻기가 나온다. 새로고침한 뒤에도 표시가 남도록 기억 적용 여부를 상태에 저장한다

**작업**
- [x] Store 테이블 생성(`scripts/setup-store.ts`), 익명 ID 쿠키 발급, route에서 `user_id` 전달, graph를 `store`와 함께 compile → 확인: 테이블 생성, 같은 브라우저에서 요청마다 같은 ID
  - 2026-10-23: `setup()`이 `CREATE SCHEMA IF NOT EXISTS`를 실행하므로 스키마가 이미 있어도 DB CREATE 권한이 필요했다(42501). 체크포인트·피드백과 같이 권한을 임시 부여·회수하는 절차로 실행했다. `langgraph.store`·`store_migrations` 생성(마이그레이션 0~3), 쓰기·읽기·삭제 확인
  - `PostgresStore`는 기존 Pool을 받지 않아 체크포인트와 별도의 Pool을 만든다(`lib/db/store.ts`)
  - 쿠키 `uid`(httpOnly, SameSite=Lax, 운영에서 Secure, 1년): 로컬에서 같은 쿠키로 두 번 요청 시 첫 응답에만 Set-Cookie, 두 번째 요청은 같은 ID 사용. 형식 오류(400) 응답에는 발급하지 않는다. 노드에서 `user_id`를 읽는 것은 작업 2에서 확인
- [x] clarify 노드에서 Store 조회·저장·삭제, 기억 적용 여부를 상태와 route 이벤트(`clarify` step)에 추가 → 확인: 같은 쿠키는 두 번째 애매한 질문부터 되묻지 않음, 다른 쿠키는 되물음, 후보에 없는 선호는 되물음
  - 2026-10-23: 상태 `frameworkRemembered`(classify가 질문마다 false로 초기화), `clarify` step에 `remembered`. 요청 본문 `ignoreMemory`(작업 3의 "변경"용)를 `configurable.ignore_memory`로 전달하고, 재개 요청에도 항상 넘긴다. 재개 시 clarify가 처음부터 다시 실행되는데, 그사이 기억이 생기면(다른 탭에서 선택) 사용자의 선택 대신 기억이 적용되기 때문이다
  - 노드 단독 확인(InMemoryStore, LLM 없음): 선택 후 저장, 같은 사용자 두 번째는 되묻지 않고 적용, 다른 사용자·후보에 없는 선호·`ignore_memory`는 되물음, "구분 없이 찾기"는 삭제, `user_id`가 없으면 Store를 쓰지 않음
  - 로컬 서버(운영 DB): 쿠키 A가 "메모리는 어떻게 써?"에서 LangGraph 선택 → 새 대화 "스트리밍은 어떻게 구현해?"는 되묻지 않고 `remembered: true`로 LangGraph 검색. 쿠키 B는 같은 질문에서 되물음. 쿠키 A + `ignoreMemory`는 되물음(기억 유지). 확인 후 테스트 대화 4개·Store 행 삭제
- [x] UI: 기억 적용 표시와 "변경"(기억을 무시하고 분기 재실행), 그래프 패널의 clarify 표시, 저장된 대화를 다시 불러왔을 때의 표시 → 확인: 화면 확인(라이트·다크)
  - 2026-10-23: 답변 위 "기억된 선택 · LangGraph 문서에서 찾았어요 · 변경"(답변 전에는 처리 과정 목록의 "기억된 선택 · … 문서에서 검색"과 겹쳐 답변이 나온 뒤 표시), 그래프 패널 clarify 옆 "기억 적용". 다시 불러온 대화는 `threads.ts`가 턴 끝 체크포인트의 `frameworkRemembered`·`framework`로 표시한다. "변경"은 질문 직전 체크포인트에서 `ignoreMemory`로 다시 실행하고, 그 실행이 실패해 재시도할 때도 기억을 적용하지 않는다
  - 로컬 화면 확인(브라우저 자동 실행, 운영 DB): 새 쿠키로 "메모리는 어떻게 써?" → LangGraph 선택 → 새 대화 "스트리밍은 어떻게 구현해?"가 되묻지 않고 기억 적용(처리 과정·그래프 패널), 새로고침 후 표시·"변경" 유지(라이트·다크), "변경" → 2/2 분기로 되물음, 기억은 유지. 확인 후 테스트 대화 2개·Store 행 삭제
  - 기존 동작: 답하지 않은 되물음 분기는 다른 분기에서 볼 때 분기 목록에 나오지 않는다(답변 없는 분기 숨김 규칙)
- [x] 문서: ADR(익명 쿠키 식별, 자동 적용), schema.md(Store 테이블·`cleanup-threads`와의 관계), README
  - 2026-10-24: ADR-012 작성, schema.md에 Store 절(테이블·namespace·생성 절차·`cleanup-threads`가 지우지 않음) 추가, README에 기능·설계 절·구조·실행 절차·ADR 목록 반영
  - 2026-10-24 운영(Vercel) 확인, 브라우저 자동 실행: 새 쿠키로 "메모리는 어떻게 써?" → LangGraph 선택(Store에 `{ framework: "langgraph" }` 저장) → 새 대화 "스트리밍은 어떻게 구현해?"가 되묻지 않고 "기억된 선택 · LangGraph 문서에서 찾았어요" 표시, 그래프 패널 "기억 적용". 새로고침 후 표시 유지(라이트·다크), "변경" → 2/2 분기로 되물음. 쿠키 `uid`는 httpOnly·Secure·SameSite=Lax. 확인 후 테스트 대화 2개·Store 행 삭제

## 참고

- [LangGraph.js 문서](https://langchain-ai.github.io/langgraphjs/)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [Neon pgvector 가이드](https://neon.com/docs/extensions/pgvector)
