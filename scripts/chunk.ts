// data/pages.json의 MDX를 정리하고 헤딩(섹션) 단위로 청킹해 data/chunks.json에 저장
import { readFile, writeFile } from "node:fs/promises";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 150;
const DATA_DIR = new URL("../data/", import.meta.url);

type Page = { url: string; title: string; content: string };
export type Chunk = { source_url: string; title: string; chunk_index: number; content: string };

const FENCE = /^\s*(`{3,}|~{3,})/;
const HTML_TAGS = "div|span|p|a|img|br|button|ul|ol|li|table|thead|tbody|tr|td|th|strong|em|code|iframe|video|source|sup|sub|details|summary";
const TITLED_TAG = /<[A-Z][\w.]*\b[^>]*?\b(?:title|path|label)="([^"]*)"[^>]*>/g;
const ANY_TAG = new RegExp(`</?(?:[A-Z][\\w.]*|${HTML_TAGS})\\b[^>]*>`, "g");

// 코드 블록 밖 텍스트의 MDX 태그 정리. 인라인 코드(`...`)는 건드리지 않는다
function cleanProse(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
            .replace(/<(svg|script|style)\b[\s\S]*?<\/\1>/g, "")
            .replace(TITLED_TAG, "**$1**")
            .replace(ANY_TAG, ""),
    )
    .join("")
    .replace(/^[ \t]+$/gm, "");
}

// 헤딩 기준으로 섹션 분리. 코드 블록 안의 `#` 주석은 헤딩으로 보지 않는다
function toSections(md: string, pageTitle: string) {
  const sections: { path: string; lines: string[] }[] = [];
  const headings: string[] = [];
  let current = { path: pageTitle, lines: [] as string[] };
  let prose: string[] = [];
  let fence: string | null = null;
  let inExport = false;

  const flushProse = () => {
    current.lines.push(cleanProse(prose.join("\n")));
    prose = [];
  };

  for (const line of md.split("\n")) {
    // 페이지 상단의 MDX 컴포넌트 정의(export const X = ... };)는 통째로 버린다
    if (inExport) {
      if (line === "};") inExport = false;
      continue;
    }
    const fenceMatch = line.match(FENCE);
    if (fence) {
      current.lines.push(line);
      if (fenceMatch && line.trim() === fence) fence = null;
      continue;
    }
    if (fenceMatch) {
      flushProse();
      fence = fenceMatch[1];
      current.lines.push(line.replace(/^(\s*[`~]{3,}\w*).*/, "$1")); // theme={...} 등 메타 제거
      continue;
    }
    if (line.startsWith("export const ")) {
      inExport = true;
      continue;
    }
    const heading = line.match(/^(#{1,3}) (.+)/);
    if (heading) {
      flushProse();
      sections.push(current);
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = heading[2].trim();
      current = { path: [pageTitle, ...headings.slice(1)].filter(Boolean).join(" > "), lines: [] };
      continue;
    }
    prose.push(line);
  }
  flushProse();
  sections.push(current);
  return sections;
}

const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
});

const pages: Page[] = JSON.parse(await readFile(new URL("pages.json", DATA_DIR), "utf8"));
const chunks: Chunk[] = [];

for (const page of pages) {
  let chunkIndex = 0;
  // 모델 제공사별 탭처럼 같은 코드가 반복되면 동일 청크가 생기므로 페이지 내 중복 제거
  const seen = new Set<string>();
  for (const section of toSections(page.content, page.title)) {
    const body = section.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!body) continue;
    for (const piece of await splitter.splitText(body)) {
      // 섹션 경로를 붙여 짧은 청크도 문맥을 갖게 한다
      const content = `${section.path}\n\n${piece}`;
      if (seen.has(content)) continue;
      seen.add(content);
      chunks.push({ source_url: page.url, title: page.title, chunk_index: chunkIndex++, content });
    }
  }
}

await writeFile(new URL("chunks.json", DATA_DIR), JSON.stringify(chunks, null, 2));

const lengths = chunks.map((c) => c.content.length).sort((a, b) => a - b);
console.log(
  `saved ${chunks.length} chunks from ${pages.length} pages → data/chunks.json ` +
    `(chars: median ${lengths[lengths.length >> 1]}, max ${lengths[lengths.length - 1]})`,
);
