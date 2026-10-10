// 평가 스크립트(eval.ts, eval-compound.ts)가 함께 쓰는 정답 판정
// - 정답은 "페이지#섹션 경로" 단위. 섹션 경로는 청크 첫 줄(`제목 > 섹션 > 하위 섹션`, scripts/chunk.ts)에서 제목을 뺀 것이고,
//   하위 섹션 청크도 정답으로 친다 ("Timeouts"는 "Timeouts > NodeTimeoutError"도 포함)
import { readFile } from "node:fs/promises";
import type { Chunk } from "./chunk";

const BASE_URL = "https://docs.langchain.com/oss/javascript/";

// 청크 → "페이지#섹션 경로" (페이지 도입부는 섹션 경로가 빈 문자열)
export function chunkRef(chunk: { source_url: string; title: string; content: string }) {
  const path = chunk.content.split("\n", 1)[0];
  const section = path === chunk.title ? "" : path.slice(chunk.title.length + " > ".length);
  return `${chunk.source_url.replace(BASE_URL, "")}#${section}`;
}
export const matches = (ref: string, gold: string) => ref === gold || ref.startsWith(`${gold} > `);

// 정답 섹션 오타·문서 개편으로 아무 청크와도 안 맞는 정답이 있으면 점수가 조용히 깎이므로 먼저 확인
export async function exitIfUnknownGold(golds: string[]) {
  const chunks: Chunk[] = JSON.parse(await readFile(new URL("../data/chunks.json", import.meta.url), "utf8"));
  const refs = chunks.map(chunkRef);
  const unknown = golds.filter((gold) => !refs.some((ref) => matches(ref, gold)));
  if (unknown.length > 0) {
    console.error(`relevant sections not found in data/chunks.json:\n  ${unknown.join("\n  ")}`);
    process.exit(1);
  }
}
