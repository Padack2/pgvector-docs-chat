// data/chunks.json을 DB와 동기화한다 (ADR-002)
// - 청크 본문이 DB와 같은 페이지: 건너뜀 (임베딩 호출 없음)
// - 바뀌었거나 새로운 페이지: 해당 페이지 청크만 삭제 후 재삽입 (페이지 단위 트랜잭션)
// - DB에만 있는 페이지: 문서에서 사라진 것으로 보고 삭제
// 추가·변경·삭제된 페이지는 바뀐 섹션의 전/후 본문과 함께 doc_changes에 기록한다 (청크 교체와 같은 트랜잭션)
import { readFile } from "node:fs/promises";
import pg from "pg";
import pgvector from "pgvector/pg";
import type { Chunk } from "./chunk";
import { EMBED_BATCH_SIZE, embedDocuments } from "../apps/web/src/lib/embedding";

function groupByUrl<T extends { source_url: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(row.source_url, [...(map.get(row.source_url) ?? []), row]);
  return map;
}

const chunks: Chunk[] = JSON.parse(await readFile(new URL("../data/chunks.json", import.meta.url), "utf8"));
const pages = groupByUrl(chunks);

const client = new pg.Client({ connectionString: process.env.EMBED_DATABASE_URL });
await client.connect();

const { rows } = await client.query<{ source_url: string; title: string; content: string }>(
  "SELECT source_url, title, content FROM doc_chunks ORDER BY source_url, chunk_index",
);
const stored = groupByUrl(rows);

const isSame = (a: { content: string }[] = [], b: { content: string }[]) =>
  a.length === b.length && a.every((row, i) => row.content === b[i].content);

const changed = [...pages].filter(([url, pageChunks]) => !isSame(stored.get(url), pageChunks));
const removed = [...stored.keys()].filter((url) => !pages.has(url));
console.log(
  `pages: ${pages.size} total, ${changed.length} new/changed, ` +
    `${pages.size - changed.length} unchanged, ${removed.length} removed`,
);

// 청크 첫 줄의 섹션 경로(chunk.ts)로 묶어 섹션별 본문을 만든다
function toSections(rows: { content: string }[] = []): Map<string, string> {
  const map = new Map<string, string>();
  for (const { content } of rows) {
    const split = content.indexOf("\n\n");
    const path = split < 0 ? content : content.slice(0, split);
    const body = split < 0 ? "" : content.slice(split + 2);
    map.set(path, map.has(path) ? `${map.get(path)}\n\n${body}` : body);
  }
  return map;
}

type SectionChange = { path: string; change: "added" | "changed" | "removed"; before: string | null; after: string | null };

function diffSections(before?: { content: string }[], after?: { content: string }[]): SectionChange[] {
  const old = toSections(before);
  const now = toSections(after);
  const changes: SectionChange[] = [];
  for (const [path, body] of now) {
    if (!old.has(path)) changes.push({ path, change: "added", before: null, after: body });
    else if (old.get(path) !== body) changes.push({ path, change: "changed", before: old.get(path)!, after: body });
  }
  for (const [path, body] of old) {
    if (!now.has(path)) changes.push({ path, change: "removed", before: body, after: null });
  }
  return changes;
}

async function recordChange(url: string, title: string, change: "added" | "changed" | "removed", pageChunks?: Chunk[]) {
  await client.query(
    "INSERT INTO doc_changes (source_url, title, change, sections) VALUES ($1, $2, $3, $4)",
    [url, title, change, JSON.stringify(diffSections(stored.get(url), pageChunks))],
  );
}

async function transaction(fn: () => Promise<void>) {
  await client.query("BEGIN");
  try {
    await fn();
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

for (const url of removed) {
  await transaction(async () => {
    await client.query("DELETE FROM doc_chunks WHERE source_url = $1", [url]);
    await recordChange(url, stored.get(url)![0].title, "removed");
  });
}

async function writePage(url: string, pageChunks: Chunk[], embeddings: number[][]) {
  await transaction(async () => {
    await client.query("DELETE FROM doc_chunks WHERE source_url = $1", [url]);
    await client.query(
      `INSERT INTO doc_chunks (source_url, title, chunk_index, content, embedding)
       SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::vector[])`,
      [
        pageChunks.map((c) => c.source_url),
        pageChunks.map((c) => c.title),
        pageChunks.map((c) => c.chunk_index),
        pageChunks.map((c) => c.content),
        embeddings.map((e) => pgvector.toSql(e)),
      ],
    );
    await recordChange(url, pageChunks[0].title, stored.has(url) ? "changed" : "added", pageChunks);
  });
}

// 임베딩 요청 1회에 담을 만큼 페이지를 묶어서 처리한다
// 중간에 실패해도 이미 저장된 페이지는 다음 실행 때 "unchanged"로 건너뛴다
// 일일 한도(약 1,000건)는 챗봇 질문 임베딩과 공유하므로 1회 실행에서 상한까지만 임베딩하고 나머지는 다음 실행으로 넘긴다
const MAX_EMBED_PER_RUN = 800;
let done = 0;
let embedded = 0;
for (let i = 0; i < changed.length; ) {
  const batch: [string, Chunk[]][] = [];
  let size = 0;
  while (i < changed.length && (batch.length === 0 || size + changed[i][1].length <= EMBED_BATCH_SIZE)) {
    size += changed[i][1].length;
    batch.push(changed[i++]);
  }
  if (embedded + size > MAX_EMBED_PER_RUN) {
    console.log(`  embedding limit (${MAX_EMBED_PER_RUN}/run) reached, ${changed.length - done} pages left for next run`);
    break;
  }
  embedded += size;

  const embeddings = await embedDocuments(batch.flatMap(([, pageChunks]) => pageChunks.map((c) => c.content)));
  let offset = 0;
  for (const [url, pageChunks] of batch) {
    await writePage(url, pageChunks, embeddings.slice(offset, (offset += pageChunks.length)));
  }
  done += batch.length;
  console.log(`  ${done}/${changed.length} pages written`);
}

const { rows: [{ count }] } = await client.query("SELECT count(*)::int AS count FROM doc_chunks");
console.log(`done. doc_chunks rows: ${count}`);
await client.end();
