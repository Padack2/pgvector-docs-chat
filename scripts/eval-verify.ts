// 답변 코드 검증 평가: 검색 품질 평가셋(eval/questions.json) 중 구현 방법을 묻는 질문을 챗봇과 같은 순서
// (classify → 하위 질문별 research 병렬 → generate → 코드 검증)로 실행해, 답변 코드의 API 에러 비율과
// 그중 출처 문서 코드에도 있는 에러("출처에도 있음")와 없는 에러("출처에 없음")의 비율을 잰다 (plan.md Phase 8).
// - 개념 설명·비교·설정 항목·에러 원인을 묻는 질문은 답변에 코드가 거의 없어 제외했다
// - classify가 프레임워크를 되물어도 고르지 않고 전체 문서에서 찾는다 (eval-compound와 같음). 체크포인트는 쓰지 않는다
// - 출처 비교 분류가 맞는지 사람이 확인하도록 --out <파일>에 답변 원문과 에러를 저장한다
// 먼저 apps/web에서 scripts/bundle-types.mjs로 types-bundle/을 만들어 둬야 한다 (pnpm --filter web dev·build가 실행함)
//   예: GEMINI_MODEL=gemini-3.1-flash-lite pnpm --filter scripts eval-verify --out /tmp/verify.json
// LLM을 질문당 3~10번 호출한다
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classify } from "../apps/web/src/lib/graph/nodes/classify";
import { generate } from "../apps/web/src/lib/graph/nodes/generate";
import { mergeResearched, research } from "../apps/web/src/lib/graph/research";
import type { GraphStateType, ResearchResult } from "../apps/web/src/lib/graph/state";

// verify.ts는 cwd 기준으로 apps/web/types-bundle을 찾는다
process.chdir(fileURLToPath(new URL("../apps/web/", import.meta.url)));
const { verifyAnswer } = await import("../apps/web/src/lib/verify");

const IDS = [
  ...["c02", "c03", "c04", "c06", "c07", "c09", "c12", "c13", "c14", "c15", "c25", "c27", "c28", "c30"],
  ...["k01", "k02", "k04", "k10", "k12", "e06"],
];
const all: { id: string; question: string }[] = JSON.parse(
  await readFile(new URL("eval/questions.json", import.meta.url), "utf8"),
);
const questions = IDS.map((id) => all.find((q) => q.id === id)!);
const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;

const model =
  process.env.LLM_PROVIDER === "ollama" ? `ollama:${process.env.OLLAMA_MODEL}` : `gemini:${process.env.GEMINI_MODEL}`;
console.log(`model: ${model} (실패하면 llm.ts의 다음 모델로 넘어감)\n`);
// Gemini 무료 티어는 모델당 분당 5요청이라 질문 사이를 띄운다
const DELAY_MS = process.env.LLM_PROVIDER === "ollama" ? 0 : 30_000;

// Gemini LLM 호출을 센다 (임베딩 호출은 제외)
let llmCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (String(input instanceof Request ? input.url : input).includes(":generateContent")) llmCalls++;
  return originalFetch(input, init);
};

// 모든 모델이 실패하면(503·시간 초과가 겹칠 때) 1분 쉬고 다시 시도한다. llm.ts가 실패한 모델을 1분간 건너뛰기 때문
async function withRetry<T>(name: string, run: () => Promise<T>, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (error) {
      if (i >= attempts) throw error;
      console.warn(`${name} failed (${i}/${attempts}), retrying in 60s`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}

const results = [];
const totals = { withCode: 0, withError: 0, errors: 0, inSource: 0, llm: 0 };
const times: number[] = [];

for (const [i, q] of questions.entries()) {
  if (i > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  llmCalls = 0;
  const state = { messages: [{ role: "user", content: q.question }] } as unknown as GraphStateType;
  Object.assign(state, await withRetry("classify", () => classify(state)));
  state.researched = state.needsSearch
    ? await withRetry("research", async () =>
        (await Promise.all(state.subQueries.map((question) => research({ question, framework: null })))).flatMap(
          // research는 항상 배열을 반환한다 (Overwrite는 classify만 씀)
          (update) => update.researched as ResearchResult[],
        ),
      )
    : [];
  const { messages } = await withRetry("generate", () => generate(state));
  const answer = (messages as { text: string }[])[0].text;
  const documents = state.needsSearch ? mergeResearched(state.researched, state.subQueries) : [];

  const start = performance.now();
  const verify = verifyAnswer(answer, documents.map((doc) => doc.source_url));
  times.push(performance.now() - start);

  const inSource = verify.errors.filter((e) => e.inSource).length;
  if (verify.blocks) totals.withCode++;
  if (verify.errors.length) totals.withError++;
  totals.errors += verify.errors.length;
  totals.inSource += inSource;
  totals.llm += llmCalls;
  console.log(
    `${q.id}  TS 코드 ${verify.blocks}개, 에러 ${verify.errors.length}개 (출처에도 있음 ${inSource})  (LLM ${llmCalls}회)  ${q.question}`,
  );
  for (const e of verify.errors) {
    const where = e.inSource ? "출처에도 있음" : "출처에 없음";
    console.log(`      [${where}] 코드 ${e.block + 1} ${e.line}행 TS${e.code} ${e.api}: ${e.message.split("\n", 1)[0]}`);
  }
  results.push({ ...q, answer, verify, sources: documents.map((doc) => doc.source_url) });
}

const n = questions.length;
const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
console.log(`\nTS 코드가 있는 답변 ${totals.withCode}/${n}, 그중 판정 에러가 있는 답변 ${totals.withError}/${totals.withCode}`);
console.log(`판정 에러 ${totals.errors}개: 출처에도 있음 ${totals.inSource}, 출처에 없음 ${totals.errors - totals.inSource}`);
console.log(`검사 시간 중앙값 ${median.toFixed(0)}ms, 질문당 평균 LLM 호출 ${(totals.llm / n).toFixed(1)}회`);
if (out) {
  await writeFile(out, JSON.stringify(results, null, 2));
  console.log(`답변·에러 저장: ${out}`);
}

// pgvector.ts의 커넥션 풀이 열려 있어 명시적으로 종료
process.exit(0);
