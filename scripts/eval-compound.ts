// 복합 질문 평가: eval/compound-questions.json의 질문(하위 주제 2개 이상)마다 챗봇과 같은 방식으로 검색해,
// 하위 주제마다 정답 섹션이 답변 컨텍스트에 들어갔는지 잰다
// - 지표: 모든 하위 주제가 컨텍스트에 들어간 질문 비율 (all covered), 하위 주제 단위 비율 (subtopic recall)
// - 정답 섹션 기준: 그 섹션만 읽어도 하위 주제에 답할 수 있고, 질문이 지정한 프레임워크 범위 안일 것
//   (예: createAgent 질문에 Deep Agents 섹션은 정답 아님, 링크만 있는 섹션·"방법"을 묻는데 개요뿐인 페이지 도입부도 아님)
// - grade → rewrite 재검색은 빼고 검색 단계만 비교한다 (--graph를 주면 재검색을 포함한 방식도 함께 잰다)
// - classify가 프레임워크를 되물어도 고르지 않고 전체 문서에서 찾는다 ("구분 없이 찾기"와 같음)
// - classify 한 번의 출력으로 두 방식을 함께 잰다 (같은 호출이라 모델 차이가 비교에 섞이지 않음, ADR-007)
//   - 기준선: searchQuery 1개로 상위 k청크
//   - 분해: subQueries마다 검색해 순위별로 번갈아 합침 (같은 청크는 하나만), 상위 k청크
// - --graph: 챗봇처럼 하위 질문마다 research 서브그래프(retrieve → grade → rewrite)를 병렬 실행해 mergeResearched로 합친다.
//   질문당 Gemini 호출 수와 재작성(rewrite) 횟수도 센다 (실패해서 다음 모델로 넘어간 호출 포함)
// - --single: 단일 주제 질문(eval/questions.json, 검색 품질 평가셋)으로 잰다. 분해가 단일 질문을 나쁘게 만들지 않는지 확인용 (ADR-007)
//   정답 섹션 중 하나라도 컨텍스트에 들어가면 맞은 것으로 본다 (eval.ts와 같음)
// LLM을 질문마다 1번 호출한다 (--graph면 하위 질문마다 grade·rewrite가 더 붙어 질문당 3~10번). 모델은 apps/web/.env.local 설정을 따르고, 실행할 때 환경 변수로 바꿀 수 있다
import { readFile } from "node:fs/promises";
import { searchChunks, type RetrievedChunk } from "../apps/web/src/lib/db/pgvector";
import { classify } from "../apps/web/src/lib/graph/nodes/classify";
import { mergeResearched, research } from "../apps/web/src/lib/graph/research";
import type { GraphStateType, ResearchResult } from "../apps/web/src/lib/graph/state";
import { chunkRef, exitIfUnknownGold, matches } from "./eval-refs";

type Question = {
  id: string;
  lang: "ko" | "en";
  question: string;
  subtopics: { topic: string; relevant: string[] }[];
};

const SINGLE = process.argv.includes("--single");
const questions: Question[] = SINGLE
  ? (
      JSON.parse(await readFile(new URL("eval/questions.json", import.meta.url), "utf8")) as (Omit<
        Question,
        "subtopics"
      > & { relevant: string[] })[]
    ).map(({ relevant, ...q }) => ({ ...q, subtopics: [{ topic: "정답", relevant }] }))
  : JSON.parse(await readFile(new URL("eval/compound-questions.json", import.meta.url), "utf8"));
await exitIfUnknownGold(questions.flatMap((q) => q.subtopics.flatMap((s) => s.relevant)));

const GRAPH = process.argv.includes("--graph");
const model =
  process.env.LLM_PROVIDER === "ollama" ? `ollama:${process.env.OLLAMA_MODEL}` : `gemini:${process.env.GEMINI_MODEL}`;
console.log(`model: ${model} (실패하면 llm.ts의 다음 모델로 넘어감)\n`);
// Gemini 무료 티어는 모델당 분당 5요청이라 호출 사이를 띄운다
const DELAY_MS = process.env.LLM_PROVIDER === "ollama" ? 0 : 13_000;
// 하위 질문 하나당 가져오는 청크 수 (섹션 중복 제거 후에도 상한을 채울 수 있게 넉넉히)
const PER_QUERY = 10;

// Gemini LLM 호출을 센다. 노드별 프롬프트 첫 문장으로 재작성 호출을 구분한다 (임베딩 호출은 제외)
const calls = { llm: 0, rewrite: 0 };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (String(input instanceof Request ? input.url : input).includes(":generateContent")) {
    calls.llm++;
    if (String(init?.body).includes("검색 쿼리 작성자")) calls.rewrite++;
  }
  return originalFetch(input, init);
};

// 하위 질문별 결과를 1위끼리, 2위끼리 번갈아 합친다. 같은 청크는 먼저 나온 것만 남긴다
function interleave(lists: RetrievedChunk[][]) {
  const merged: RetrievedChunk[] = [];
  const seen = new Set<string>();
  for (let rank = 0; rank < PER_QUERY; rank++) {
    for (const list of lists) {
      const chunk = list[rank];
      if (!chunk || seen.has(chunk.content)) continue;
      seen.add(chunk.content);
      merged.push(chunk);
    }
  }
  return merged;
}
// 같은 섹션의 청크는 하나만 남긴다 (ADR-007 옵션 B1)
function dedupeSection(chunks: RetrievedChunk[]) {
  const seen = new Set<string>();
  return chunks.filter((chunk) => !seen.has(chunkRef(chunk)) && seen.add(chunkRef(chunk)));
}

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

type Retrieved = { single: RetrievedChunk[]; merged: RetrievedChunk[]; researched: RetrievedChunk[] };
const METHODS: Record<string, (r: Retrieved) => RetrievedChunk[]> = {
  "기준선 5청크": (r) => r.single.slice(0, 5),
  "기준선 8청크": (r) => r.single.slice(0, 8),
  "분해 5청크": (r) => r.merged.slice(0, 5),
  "분해 8청크": (r) => r.merged.slice(0, 8),
  "분해 8청크 + 섹션 중복 제거": (r) => dedupeSection(r.merged).slice(0, 8),
  "분해 10청크": (r) => r.merged.slice(0, 10),
  ...(GRAPH && { "그래프 경유 (grade·rewrite 포함)": (r: Retrieved) => r.researched }),
};
const score = Object.fromEntries(Object.keys(METHODS).map((name) => [name, { all: 0, sub: 0 }]));
// 하위 질문 수별 질문 수, 질문당 호출 수 합계
const splits: Record<number, number> = {};
const totals = { llm: 0, rewrite: 0 };

for (const [i, q] of questions.entries()) {
  if (i > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  calls.llm = calls.rewrite = 0;
  const { searchQuery = "", subQueries = [] } = await withRetry("classify", () =>
    classify({ messages: [{ role: "user", content: q.question }] } as unknown as GraphStateType),
  );
  const retrieved: Retrieved = {
    single: await searchChunks(searchQuery, PER_QUERY),
    merged: interleave(await Promise.all(subQueries.map((sub) => searchChunks(sub, PER_QUERY)))),
    // 되물어도 고르지 않으므로 framework는 전체(null). 챗봇의 Send처럼 하위 질문을 병렬 실행한다
    researched: GRAPH
      ? await withRetry("research", async () =>
          mergeResearched(
            (await Promise.all(subQueries.map((question) => research({ question, framework: null })))).flatMap(
              // research는 항상 배열을 반환한다 (Overwrite는 classify만 씀)
              (update) => update.researched as ResearchResult[],
            ),
            subQueries,
          ),
        )
      : [],
  };

  const marks: string[] = [];
  for (const [name, pick] of Object.entries(METHODS)) {
    const refs = pick(retrieved).map(chunkRef);
    const covered = q.subtopics.map((s) => refs.some((ref) => s.relevant.some((gold) => matches(ref, gold))));
    score[name].sub += covered.filter(Boolean).length;
    if (covered.every(Boolean)) score[name].all++;
    if (name === "기준선 5청크" || name === "분해 8청크" || name.startsWith("그래프 경유")) {
      marks.push(`${name}: ${q.subtopics.map((s, j) => `${covered[j] ? "+" : "-"}${s.topic}`).join(" ")}`);
    }
  }
  splits[subQueries.length] = (splits[subQueries.length] ?? 0) + 1;
  totals.llm += calls.llm;
  totals.rewrite += calls.rewrite;
  console.log(`${q.id}  ${marks.join("  |  ")}${GRAPH ? `  (LLM ${calls.llm}회, 재작성 ${calls.rewrite}회)` : ""}`);
  console.log(`      query: ${searchQuery}`);
  for (const sub of subQueries) console.log(`      sub:   ${sub}`);
}

const totalSubtopics = questions.reduce((sum, q) => sum + q.subtopics.length, 0);
console.log(`\n${"".padEnd(28)}all covered  subtopic recall`);
for (const [name, s] of Object.entries(score)) {
  console.log(
    `${name.padEnd(28)}${`${s.all}/${questions.length}`.padStart(11)}  ${`${s.sub}/${totalSubtopics}`.padStart(15)}`,
  );
}
console.log(`\n하위 질문 수별 질문 수: ${Object.entries(splits).map(([n, count]) => `${n}개 ${count}`).join(", ")}`);
if (GRAPH) {
  const avg = (n: number) => (n / questions.length).toFixed(1);
  console.log(`질문당 평균 LLM 호출 ${avg(totals.llm)}회 (재작성 ${avg(totals.rewrite)}회), 합계 ${totals.llm}회`);
}

// pgvector.ts의 커넥션 풀이 열려 있어 명시적으로 종료
process.exit(0);
