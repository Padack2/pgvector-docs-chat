// 검색 품질 평가: eval/questions.json의 질문마다 챗봇과 같은 검색 쿼리를 돌려 정답 섹션이 몇 번째 청크에 나오는지 잰다
// - 정답은 "페이지#섹션 경로" 단위 (판정 방식은 eval-refs.ts)
// - Hit@k: 상위 k개 청크 중 정답 청크가 하나라도 있는 질문 비율 (챗봇은 k=5로 검색)
// - MRR: 첫 정답 청크 순위의 역수 평균 (상위 MAX_RANK개 안에 없으면 0)
// 질문 임베딩은 data/eval-embeddings.json에 캐시해 질문이 바뀌지 않으면 임베딩 API를 다시 부르지 않는다 (무료 티어 일일 한도 절약)
import { readFile, writeFile } from "node:fs/promises";
import { embedQuery } from "../apps/web/src/lib/embedding";
import { searchByEmbedding } from "../apps/web/src/lib/db/pgvector";
import { chunkRef, exitIfUnknownGold, matches } from "./eval-refs";

type Question = { id: string; lang: "ko" | "en"; type: "concept" | "keyword" | "error"; question: string; relevant: string[] };

const MAX_RANK = 20;
const HIT_KS = [1, 3, 5, 10];

const questions: Question[] = JSON.parse(await readFile(new URL("eval/questions.json", import.meta.url), "utf8"));

await exitIfUnknownGold(questions.flatMap((q) => q.relevant));

const cacheUrl = new URL("../data/eval-embeddings.json", import.meta.url);
const cache: Record<string, number[]> = JSON.parse(await readFile(cacheUrl, "utf8").catch(() => "{}"));
const missing = questions.filter((q) => !cache[q.question]);
if (missing.length > 0) {
  console.log(`embedding ${missing.length} new questions...`);
  // 실패해도 그때까지 받은 임베딩은 남기도록 질문마다 저장
  for (const q of missing) {
    cache[q.question] = await embedQuery(q.question);
    await writeFile(cacheUrl, JSON.stringify(cache));
  }
}

const results = [];
for (const q of questions) {
  const rows = await searchByEmbedding(cache[q.question], MAX_RANK);
  const index = rows.findIndex((row) => q.relevant.some((gold) => matches(chunkRef(row), gold)));
  results.push({ ...q, rank: index === -1 ? null : index + 1, top1: chunkRef(rows[0]) });
}

function summarize(label: string, group: typeof results) {
  const hits = HIT_KS.map((k) => group.filter((r) => r.rank !== null && r.rank <= k).length / group.length);
  const mrr = group.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / group.length;
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
  console.log(`${label.padEnd(14)}${String(group.length).padStart(4)}${hits.map(pct).join("")}${mrr.toFixed(3).padStart(8)}`);
}

console.log(`\n${"".padEnd(14)}${"n".padStart(4)}${HIT_KS.map((k) => `@${k}`.padStart(5)).join("")}${"MRR".padStart(8)}`);
summarize("all", results);
for (const lang of ["ko", "en"]) summarize(`lang=${lang}`, results.filter((r) => r.lang === lang));
for (const type of ["concept", "keyword", "error"]) summarize(`type=${type}`, results.filter((r) => r.type === type));

// 챗봇이 실제로 받는 상위 5개에 정답이 없는 질문 = 개선 대상
const misses = results.filter((r) => r.rank === null || r.rank > 5);
console.log(`\nmisses (rank > 5): ${misses.length}`);
for (const r of misses) {
  console.log(`  ${r.id} [${r.lang}/${r.type}] rank=${r.rank ?? `>${MAX_RANK}`} top1=${r.top1}\n      ${r.question}`);
}

// pgvector.ts의 커넥션 풀이 열려 있어 명시적으로 종료
process.exit(0);
