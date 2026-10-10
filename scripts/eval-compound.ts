// 복합 질문 평가: eval/compound-questions.json의 질문(하위 주제 2개 이상)마다 챗봇과 같은 방식으로 검색해,
// 하위 주제마다 정답 섹션이 답변 컨텍스트에 들어갔는지 잰다
// - 지표: 모든 하위 주제가 컨텍스트에 들어간 질문 비율 (all covered), 하위 주제 단위 비율 (subtopic recall)
// - 정답 섹션 기준: 그 섹션만 읽어도 하위 주제에 답할 수 있고, 질문이 지정한 프레임워크 범위 안일 것
//   (예: createAgent 질문에 Deep Agents 섹션은 정답 아님, 링크만 있는 섹션·"방법"을 묻는데 개요뿐인 페이지 도입부도 아님)
// - grade → rewrite 재검색은 빼고 검색 단계만 비교한다
// - classify가 프레임워크를 되물어도 고르지 않고 전체 문서에서 찾는다 ("구분 없이 찾기"와 같음)
// - classify 한 번의 출력으로 두 방식을 함께 잰다 (같은 호출이라 모델 차이가 비교에 섞이지 않음, ADR-007)
//   - 기준선: searchQuery 1개로 상위 k청크
//   - 분해: subQueries마다 검색해 순위별로 번갈아 합침 (같은 청크는 하나만), 상위 k청크
// LLM을 질문마다 1번 호출한다. 모델은 apps/web/.env.local 설정을 따르고, 실행할 때 환경 변수로 바꿀 수 있다
import { readFile } from "node:fs/promises";
import { searchChunks, type RetrievedChunk } from "../apps/web/src/lib/db/pgvector";
import { classify } from "../apps/web/src/lib/graph/nodes/classify";
import type { GraphStateType } from "../apps/web/src/lib/graph/state";
import { chunkRef, exitIfUnknownGold, matches } from "./eval-refs";

type Question = {
  id: string;
  lang: "ko" | "en";
  question: string;
  subtopics: { topic: string; relevant: string[] }[];
};

const questions: Question[] = JSON.parse(
  await readFile(new URL("eval/compound-questions.json", import.meta.url), "utf8"),
);
await exitIfUnknownGold(questions.flatMap((q) => q.subtopics.flatMap((s) => s.relevant)));

const model =
  process.env.LLM_PROVIDER === "ollama" ? `ollama:${process.env.OLLAMA_MODEL}` : `gemini:${process.env.GEMINI_MODEL}`;
console.log(`model: ${model} (실패하면 llm.ts의 다음 모델로 넘어감)\n`);
// Gemini 무료 티어는 모델당 분당 5요청이라 호출 사이를 띄운다
const DELAY_MS = process.env.LLM_PROVIDER === "ollama" ? 0 : 13_000;
// 하위 질문 하나당 가져오는 청크 수 (섹션 중복 제거 후에도 상한을 채울 수 있게 넉넉히)
const PER_QUERY = 10;

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
async function classifyWithRetry(question: string, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await classify({ messages: [{ role: "user", content: question }] } as unknown as GraphStateType);
    } catch (error) {
      if (i >= attempts) throw error;
      console.warn(`classify failed (${i}/${attempts}), retrying in 60s`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}

type Retrieved = { single: RetrievedChunk[]; merged: RetrievedChunk[] };
const METHODS: Record<string, (r: Retrieved) => RetrievedChunk[]> = {
  "기준선 5청크": (r) => r.single.slice(0, 5),
  "기준선 8청크": (r) => r.single.slice(0, 8),
  "분해 5청크": (r) => r.merged.slice(0, 5),
  "분해 8청크": (r) => r.merged.slice(0, 8),
  "분해 8청크 + 섹션 중복 제거": (r) => dedupeSection(r.merged).slice(0, 8),
  "분해 10청크": (r) => r.merged.slice(0, 10),
};
const score = Object.fromEntries(Object.keys(METHODS).map((name) => [name, { all: 0, sub: 0 }]));

for (const [i, q] of questions.entries()) {
  if (i > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  const { searchQuery = "", subQueries = [] } = await classifyWithRetry(q.question);
  const retrieved: Retrieved = {
    single: await searchChunks(searchQuery, PER_QUERY),
    merged: interleave(await Promise.all(subQueries.map((sub) => searchChunks(sub, PER_QUERY)))),
  };

  const marks: string[] = [];
  for (const [name, pick] of Object.entries(METHODS)) {
    const refs = pick(retrieved).map(chunkRef);
    const covered = q.subtopics.map((s) => refs.some((ref) => s.relevant.some((gold) => matches(ref, gold))));
    score[name].sub += covered.filter(Boolean).length;
    if (covered.every(Boolean)) score[name].all++;
    if (name === "기준선 5청크" || name === "분해 8청크") {
      marks.push(`${name}: ${q.subtopics.map((s, j) => `${covered[j] ? "+" : "-"}${s.topic}`).join(" ")}`);
    }
  }
  console.log(`${q.id}  ${marks.join("  |  ")}`);
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

// pgvector.ts의 커넥션 풀이 열려 있어 명시적으로 종료
process.exit(0);
