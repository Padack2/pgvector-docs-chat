# ADR-005: 대화 상태는 서버 체크포인트(PostgresSaver)에 저장하고 분기 기능은 API route에서 직접 구현

## 메타

- **ADR ID**: ADR-005
- **상태**: 승인
- **날짜**: 2026-10-09
- **작성자**: 김아진
- **영향 범위**: Backend / Frontend / Data / Security
- **태그**: 확장성 / 보안 / 유지보수
- **관련 ADR**:
- **링크**: plan.md Phase 5, `apps/web/src/lib/db/checkpointer.ts`, `apps/web/src/lib/threads.ts`, `docs/schema.md`, [LangSmith 요금](https://www.langchain.com/langsmith-pricing), [Next.js 배포 가이드](https://docs.langchain.com/langsmith/deploy-nextjs), [Agent Streaming Protocol](https://github.com/langchain-ai/agent-protocol/tree/main/streaming)

---

## 1) 배경 (Context)

- **문제**: 현재는 클라이언트가 매 요청마다 대화 전체를 전송하며, 서버는 대화 상태를 저장하지 않는다. 이 구조에서는 다음 기능을 구현할 수 없다.
    - 질문 수정 시 해당 시점부터 대화를 분기하고, 기존 분기를 유지하는 기능
    - 대상이 불명확한 질문에서 그래프 실행을 중단하고 사용자 확인 후 재개하는 기능 (Phase 6). LangGraph `interrupt`는 중단 시점의 상태가 checkpointer에 저장되어야 재개할 수 있다.
    - 아울러 새로고침이나 링크 공유 시 대화 내용이 유실된다.
- **제약**
    - 서비스는 Vercel 서버리스 함수(`/api/chat`)와 Neon Postgres로 운영하며, 별도 서버를 두지 않는다.
    - 챗봇의 DB 계정은 문서 테이블 읽기 전용이다. 대화 저장에는 쓰기 권한이 필요하나, 문서 테이블에 대한 쓰기 권한은 부여하지 않는다.
    - API route는 노드 진행 상황(step), 답변 토큰, 출처, interrupt를 자체 NDJSON 이벤트 형식으로 전송하며, UI는 이 형식을 기준으로 구현되어 있다.
- **목표**
    - 대화를 서버에 스레드 단위로 저장하여 새로고침·링크 공유 후에도 대화를 이어갈 수 있도록 한다.
    - 질문 수정 시 분기 생성, 분기 간 전환, interrupt 재개를 지원한다.
- **비목표**: 로그인 및 사용자별 접근 제어 (데모 서비스로서 대화 id를 아는 사용자는 열람 가능하도록 한다)

## 2) 고려한 선택지 (Options)

- 옵션 A: 현행 유지 (클라이언트가 대화 전체를 전송, 브라우저 저장소에만 보관)
    - 장점: DB·서버 변경 없음
    - 단점/리스크: 중단된 그래프 상태를 저장할 수 없어 interrupt를 사용할 수 없다. 분기는 클라이언트 측 모사만 가능하며, 링크 공유를 지원할 수 없다.
- 옵션 B: LangGraph Agent Server에 그래프를 배포하고 공식 프론트엔드 SDK `useStream` 사용
    - 장점: 스레드 저장, 분기(`checkpoint` 기반 fork, `branch`/`setBranch`), 메시지별 체크포인트 메타데이터, interrupt 처리를 SDK가 모두 제공한다.
    - 단점/리스크: Agent Server를 별도로 운영해야 한다 (LangSmith Deployment 또는 자체 호스팅). Vercel 단일 함수 구조와 맞지 않으며, 자체 이벤트(step 등)를 SDK 형식에 맞게 재구성해야 한다. 비용 측면에서 LangSmith Deployment는 무료 Developer 플랜에 포함되지 않으며, Plus 플랜($39/seat/월)에 소형 서버리스 배포 1개가 포함된다. 무료 티어 운영 원칙에 부합하지 않는다.
- 옵션 C: `useStream`의 커스텀 전송(`FetchStreamTransport`)으로 자체 API route에 연결
    - 장점: Agent Server 없이 SDK의 메시지 스트리밍·interrupt 처리를 활용한다.
    - 단점/리스크: 커스텀 모드에서는 분기 기능이 제공되지 않는다. `@langchain/langgraph-sdk` 1.12.0 타입 정의 기준으로 `UseStreamCustom`에는 `branch`·`setBranch`·`getMessagesMetadata`가 없으며, 제출 옵션에서 `checkpoint`(fork 지점)가 제외되어 있다. 따라서 분기 기능은 별도로 구현해야 한다.
- 옵션 D: API route에서 그래프를 `PostgresSaver`로 컴파일하고, 대화 조회·분기·재개를 직접 구현
    - 장점: 기존 Vercel + Neon 구조를 유지하며, 현재 이벤트 형식과 UI를 그대로 사용한다.
    - 단점/리스크: 체크포인트 이력(`getStateHistory`)으로부터 화면에 표시할 분기와 질문별 분기 목록을 산출하는 로직을 직접 구현해야 한다. 공식 SDK가 처리하는 예외 상황도 자체적으로 파악·대응해야 한다.
- 옵션 E: Agent Streaming Protocol을 Next.js API route에 직접 구현하고, 프론트엔드는 `@langchain/react`의 `HttpAgentServerAdapter`로 연결 (공식 Next.js 배포 가이드 방식)
    - 장점: Agent Server 없이 Vercel 환경에서 공식 프로토콜과 프론트엔드 SDK를 사용한다. 프로토콜에 interrupt 재개(`input.respond`), 체크포인트 기반 분기(`state.fork`), 체크포인트 목록 조회(`state.listCheckpoints`)가 정의되어 있다.
    - 단점/리스크: 프로토콜 엔드포인트(`/commands`, `/stream`(SSE), `/state`, `/history`)는 라이브러리로 제공되지 않으며, 가이드의 예제 코드를 기반으로 직접 구현해야 한다. 가이드에 따르면 서버리스 환경에서는 SSE 세션이 프로세스 단위로 관리되어, 재연결을 지원하려면 별도의 공유 저장소가 필요하다. 가이드에 분기·interrupt 사용 방법이 기술되어 있지 않아 `@langchain/react`의 분기 UI 지원 여부를 판단할 수 없다. 프로토콜 문서에 버전 및 안정성 표기가 없다.

## 3) 결정 (Decision)

- 최종 선택: 옵션 D. 체크포인트는 Neon의 `langgraph` 스키마에 저장하며, 해당 스키마에만 권한을 가진 전용 계정(`checkpoint_user`)을 둔다.
- 결정 이유(Trade-off)
    - 목표(분기·interrupt·링크 공유)를 충족하면서 별도 서버 없이 무료로 운영 가능한 선택지는 D와 E다. B는 별도 서버와 유료 플랜이 필요하고, C는 분기 기능을 별도로 구현해야 한다.
    - E는 공식 프로토콜을 따른다는 장점이 있으나, 직접 구현할 엔드포인트가 D의 NDJSON route보다 많고 분기 UI 지원 여부가 불확실하다.
    - 따라서 구현 범위가 가장 작고 현재 이벤트 형식과 UI를 유지할 수 있는 D를 채택한다.
    - 체크포인트 저장에 필요한 쓰기 권한은 챗봇 계정에 부여하지 않고, 스키마 단위로 분리된 전용 계정에 부여한다.

## 4) 결과/영향 (Consequences)

- 긍정적 영향
    - 요청 형식이 `{ threadId, message | resume, checkpointId? }`로 축소되고, 대화 기록은 서버에서 관리한다. Phase 6의 interrupt를 추가 구조 변경 없이 적용할 수 있다.
    - 재시도를 실패한 실행 직전의 체크포인트에서 수행하므로, 실패한 턴이 대화 기록에 남지 않는다.
- 부정적 영향/부채
    - JS `PostgresSaver`(1.0.6)는 채널 버전을 정수로 증가시키므로, 분기 시 두 분기의 `checkpoint_blobs` 키가 충돌하여 신규 분기의 값이 저장되지 않는다 (분기 구현 과정에서 확인). `getNextVersion`을 재정의하여 버전에 난수 접미사를 부여하는 방식으로 우회했다 (`checkpointer.ts`). 패키지 업그레이드 시 해당 재정의의 필요 여부를 재확인해야 한다.
    - 체크포인트는 노드 실행마다 누적된다 (질문 1개당 약 5~10개). 30일 이상 활동이 없는 대화를 삭제하는 스크립트(`scripts/cleanup-threads.ts`)를 수동으로 실행해야 한다.
    - 대화 id(UUID)를 아는 사용자는 누구나 해당 대화를 열람하고 이어서 질문할 수 있다.
    - `PostgresSaver.setup()`은 스키마 존재 여부와 관계없이 DB의 CREATE 권한을 검사하므로, 패키지 마이그레이션이 추가될 때마다 권한을 임시 부여한 뒤 회수해야 한다 (`docs/schema.md`).
- 추후 작업(TODO)
    - 정리 스크립트 자동 실행 (현재 수동)
    - `@langchain/react`의 분기 지원 여부 확인 후, 프론트엔드를 공식 SDK로 전환할 필요가 생기면 옵션 E 재검토

## 5) 검증/롤백 (Validation / Rollback)

- 검증 방법
    - 동일 threadId로 후속 질문("그거 예시는?") 시 이전 대화 맥락을 반영하는지 확인
    - 새로고침·링크 공유 후 대화 내용과 중단된 확인 질문이 유지되는지 확인
    - 분기 간 전환 시 각 분기의 이후 대화가 유지되는지 확인
    - 실패 후 재시도 시 실패한 턴이 기록에 남지 않는지 확인
    - `checkpoint_user`의 `doc_chunks` 쓰기 시도가 거부되는지 확인 (`scripts/setup-checkpointer.ts`)
- 롤백 전략: 그래프를 checkpointer 없이 컴파일하고, 클라이언트가 대화 전체를 전송하는 방식(옵션 A)으로 되돌린다. 이 경우 interrupt(Phase 6)와 분기 기능도 함께 제거된다.
