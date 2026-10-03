// LangChain JS 문서(langchain, langgraph, deepagents, concepts)를 마크다운으로 받아 data/pages.json에 저장
import { mkdir, writeFile } from "node:fs/promises";

const INDEX_URL =
  "https://docs.langchain.com/_llms/agent-development-lifecycle/build/type-script.md";
const SECTIONS = ["langchain", "langgraph", "deepagents", "concepts"];
const CONCURRENCY = 8;
const OUT_DIR = new URL("../data/", import.meta.url);

// 모든 페이지 상단에 붙는 llms.txt 안내 문구
const BANNER = /^> ## Documentation Index\n(?:>.*\n)*/;

type Page = { url: string; title: string; content: string };

async function fetchPage(url: string): Promise<Page | null> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  // changelog 등 일부 페이지는 .md 요청에도 HTML을 돌려준다
  if (!res.headers.get("content-type")?.startsWith("text/markdown")) return null;

  const content = (await res.text()).replace(BANNER, "").trim();
  const title = content.match(/^# (.+)$/m)?.[1].trim() ?? url;
  return { url: url.replace(/\.md$/, ""), title, content };
}

const index = await (await fetch(INDEX_URL)).text();
const urls = [
  ...new Set(
    [...index.matchAll(/\((https:\/\/docs\.langchain\.com\/oss\/javascript\/([^/)]+)\/[^)]+\.md)\)/g)]
      .filter((m) => SECTIONS.includes(m[2]))
      .map((m) => m[1]),
  ),
];

const pages: Page[] = [];
const skipped: string[] = [];
for (let i = 0; i < urls.length; i += CONCURRENCY) {
  const batch = urls.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map(fetchPage));
  results.forEach((p, j) => (p ? pages.push(p) : skipped.push(batch[j])));
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL("pages.json", OUT_DIR), JSON.stringify(pages, null, 2));

const chars = pages.reduce((n, p) => n + p.content.length, 0);
console.log(`saved ${pages.length} pages (${chars.toLocaleString()} chars) → data/pages.json`);
if (skipped.length) console.log(`skipped (not markdown):\n  ${skipped.join("\n  ")}`);
