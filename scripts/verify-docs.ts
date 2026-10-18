// 답변 코드 검증(apps/web/src/lib/verify.ts)을 문서 원본 예시 코드에 돌려, 판정 대상 에러와 제외된 에러를 집계한다.
// 발췌 코드에서 흔한 에러(TS2304 등)가 판정에서 빠지는지, 판정된 에러가 실제 API 문제인지 사람이 확인하는 용도다.
// 먼저 apps/web에서 scripts/bundle-types.mjs로 types-bundle/을 만들어 둬야 한다 (pnpm --filter web dev·build가 실행함)
// --write는 페이지별 판정 에러 키를 apps/web/src/lib/source-errors.json에 저장한다. 답변 에러가 출처 문서 예시에도 있는지
// 비교할 때 쓴다 (청크는 코드 블록이 경계에서 잘려 있어 페이지 전체로 미리 계산함). 문서를 다시 수집하면 다시 실행해야 한다
//   예: pnpm --filter scripts verify-docs            (페이지별 판정 에러 목록은 --list)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type Page = { url: string; title: string; content: string };

const pages: Page[] = JSON.parse(await readFile(new URL("../data/pages.json", import.meta.url), "utf8"));
// verify.ts는 cwd 기준으로 apps/web/types-bundle을 찾는다
process.chdir(fileURLToPath(new URL("../apps/web/", import.meta.url)));
const { checkCode, errorKey, extractCodeBlocks, JUDGED_CODES } = await import("../apps/web/src/lib/verify");

const count = (map: Map<string | number, number>, key: string | number) => map.set(key, (map.get(key) ?? 0) + 1);
const judged = new Map<string | number, number>();
const ignoredCode = new Map<string | number, number>();
const ignoredNotApi = new Map<string | number, number>();
const examples = new Map<number, string[]>();
const list: string[] = [];
const times: number[] = [];
let blocks = 0;
let failedBlocks = 0;
const failedPages = new Set<string>();
// 페이지 URL → 판정 에러 키 (--write)
const pageKeys = new Map<string, Set<string>>();

for (const page of pages) {
  for (const code of extractCodeBlocks(page.content)) {
    blocks++;
    const start = performance.now();
    const { errors, ignored } = checkCode(code);
    times.push(performance.now() - start);
    for (const c of ignored) count(JUDGED_CODES.has(c) ? ignoredNotApi : ignoredCode, c);
    if (!errors.length) continue;
    failedBlocks++;
    failedPages.add(page.url);
    for (const e of errors) {
      pageKeys.set(page.url, (pageKeys.get(page.url) ?? new Set()).add(errorKey(e)));
      count(judged, e.code);
      const line = `TS${e.code} ${e.api} — ${e.message.split("\n", 1)[0].slice(0, 160)}`;
      const ex = examples.get(e.code) ?? [];
      if (ex.length < 3) examples.set(e.code, [...ex, `${line}\n      ${page.url}`]);
      list.push(`${page.url}  L${e.line}  ${line}`);
    }
  }
}

const top = (map: Map<string | number, number>, n = 10) =>
  [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `TS${k} ${v}`).join(", ") || "-";
const first = times[0] ?? 0;
times.sort((a, b) => a - b);
console.log(`블록 ${blocks}개, 검사 시간 첫 ${Math.round(first)}ms·이후 중앙값 ${Math.round(times[times.length >> 1] ?? 0)}ms`);
console.log(`판정 에러가 있는 블록: ${failedBlocks}/${blocks} (${((failedBlocks / blocks) * 100).toFixed(1)}%), ${failedPages.size}페이지`);
console.log(`판정 에러 (코드별): ${top(judged)}`);
console.log(`제외 - 판정 대상 아닌 코드: ${top(ignoredCode)}`);
console.log(`제외 - 판정 대상 코드지만 패키지 API 아님: ${top(ignoredNotApi)}`);
console.log("\n코드별 예시:");
for (const [code, ex] of [...examples].sort((a, b) => a[0] - b[0])) {
  console.log(`  TS${code}`);
  for (const e of ex) console.log(`    ${e}`);
}
if (process.argv.includes("--list")) console.log(`\n전체 목록:\n${list.join("\n")}`);
if (process.argv.includes("--write")) {
  const out = new URL("../apps/web/src/lib/source-errors.json", import.meta.url);
  const sorted = [...pageKeys].sort(([a], [b]) => a.localeCompare(b)).map(([url, keys]) => [url, [...keys].sort()]);
  await writeFile(out, JSON.stringify(Object.fromEntries(sorted), null, 2) + "\n");
  console.log(`\n페이지별 판정 에러 키 저장: ${fileURLToPath(out)} (${sorted.length}페이지)`);
}
