# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 프로젝트: pgvector-docs-chat

LangChain JS/TS 문서 RAG 챗봇(Next.js + LangGraph + pgvector). 구조·아키텍처는 `README.md`, DB는 `docs/schema.md`, 설계 결정은 `docs/adr/`, 진행 상황은 `plan.md`를 본다.

### 명령과 검증

- 타입 체크: `apps/web/node_modules/.bin/tsc --noEmit -p apps/web`
- 린트: `pnpm --filter web lint`
- 데이터·평가 스크립트: `pnpm --filter scripts <이름>` (`apps/web/.env.local`을 읽도록 설정돼 있으므로 tsx로 직접 실행하지 않는다)
- 임시 검사 스크립트는 `apps/web/scripts/*.mts`에 두고 `scripts/node_modules/.bin/tsx`로 실행한다 (`@langchain/*` 해석 때문)
- 자동 테스트는 없다. 검증은 tsc + lint + 해당 기능의 eval 스크립트 또는 브라우저 확인으로 한다.

### 환경 (Windows + WSL, 저장소는 `/mnt/f`)

- `pnpm install`·`pnpm add`는 Windows에서만 한다. WSL에서 실행하면 공유 node_modules가 Windows에서 깨진다 → 사용자에게 요청.
- WSL의 `next dev`는 `/mnt` 아래 파일 변경을 감지하지 못한다 → 코드 수정 후 서버를 다시 시작하고 확인한다.
- `next build`는 dev 서버를 끈 뒤에만 실행한다(`.next`와 포트를 Windows와 공유). 종료는 `pkill -f "[n]ext dev"; pkill -f "[n]ext-server"` (대괄호 없이 쓰면 자기 셸도 종료됨).
- WSL git에는 GitHub 자격 증명이 없다 → push는 `git.exe push`.
- WSL git만 CRLF 차이를 수정으로 본다. `git diff --ignore-cr-at-eol`이 비어 있으면 WSL에서 `git checkout --`으로 되돌린다.
- `git add .`/`-A`를 쓰지 않는다 (`apps/web/.env.public`에 실제 키가 있음).
- 스크린샷: Playwright MCP는 Chrome이 없어 동작하지 않는다. playwright-core 스크립트에서 `executablePath`를 `~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`로 지정한다.

### DB와 외부 서비스

- DB 계정은 용도별로 나뉜다: 임베딩 쓰기(`EMBED_DATABASE_URL`), 검색 읽기 전용(`DATABASE_URL`), 체크포인트·Store·피드백(`CHECKPOINT_DATABASE_URL`).
- 테이블 생성·권한 변경 SQL은 사용자가 Neon SQL Editor에서 실행한다. `setup-*` 스크립트는 `GRANT CREATE` → 실행 → `REVOKE` 절차가 필요하다 (`docs/schema.md`).
- `data/`는 git에 없다. embed·`verify-docs --write` 전에는 crawl·chunk를 먼저 실행한다.
- Gemini 무료 티어로 운영한다: 임베딩 하루 약 1,000건(챗봇 질문과 공유), LLM은 모델별 분당 5회, `gemini-3.8-flash`는 하루 20회. LLM을 많이 부르는 평가는 `GEMINI_MODEL=gemini-3.1-flash-lite`로 고정하고 실제 실행된 모델을 결과와 함께 기록한다. 간단한 동작 확인은 `LLM_PROVIDER=ollama`로 한도를 아낀다.
