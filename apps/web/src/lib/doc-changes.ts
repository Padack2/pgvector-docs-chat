import { pool } from "./db/pgvector";

// 문서 동기화(scripts/embed.ts)가 기록한 페이지별 변경 이력과 요약(scripts/summarize-changes.ts). 챗봇은 읽기만 한다
export type DocChange = {
  id: string;
  sourceUrl: string;
  title: string;
  change: "added" | "changed" | "removed";
  // 요약 전(다음 동기화에서 처리)이면 null
  summary: string | null;
  syncedAt: Date;
};

const COLUMNS = `id, source_url AS "sourceUrl", title, change, summary, synced_at AS "syncedAt"`;

// 최근 이력 ("최근 문서 변경" 페이지)
export async function loadRecentChanges(limit = 100) {
  const { rows } = await pool.query<DocChange>(
    `SELECT ${COLUMNS} FROM doc_changes ORDER BY synced_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

// 페이지별로 since 이후의 가장 최근 이력 (source_url → 이력)
export async function loadLatestChangesSince(urls: string[], since: string) {
  if (urls.length === 0) return new Map<string, DocChange>();
  const { rows } = await pool.query<DocChange>(
    `SELECT DISTINCT ON (source_url) ${COLUMNS}
     FROM doc_changes WHERE source_url = ANY($1) AND synced_at > $2
     ORDER BY source_url, synced_at DESC, id DESC`,
    [urls, since],
  );
  return new Map(rows.map((row) => [row.sourceUrl, row]));
}
