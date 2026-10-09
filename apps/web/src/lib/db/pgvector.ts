import pg from "pg";
import pgvector from "pgvector/pg";
import { embedQuery } from "../embedding";

// 챗봇은 읽기 전용 계정(DATABASE_URL)으로만 접속한다
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export type RetrievedChunk = {
  content: string;
  title: string;
  source_url: string;
  similarity: number;
};

const DOCS_BASE_URL = "https://docs.langchain.com/oss/javascript/";

// framework를 주면 그 프레임워크 문서(source_url이 .../javascript/<framework>/로 시작)에서만 찾는다
export async function searchChunks(query: string, k = 5, framework?: string | null): Promise<RetrievedChunk[]> {
  return searchByEmbedding(await embedQuery(query), k, framework);
}

// 평가 스크립트(scripts/eval.ts)는 질문 임베딩을 캐시해 두고 이 함수로 같은 검색 쿼리를 실행한다
export async function searchByEmbedding(
  queryEmbedding: number[],
  k: number,
  framework?: string | null,
): Promise<RetrievedChunk[]> {
  const embedding = pgvector.toSql(queryEmbedding);
  if (!framework) {
    const { rows } = await pool.query<RetrievedChunk>(
      `SELECT content, title, source_url, 1 - (embedding <=> $1) AS similarity
       FROM doc_chunks
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [embedding, k],
    );
    return rows;
  }

  // HNSW는 후보(기본 40개)를 먼저 고른 뒤 WHERE로 거르므로, 필터를 걸면 k개보다 적게 나올 수 있다.
  // iterative scan(pgvector 0.8+)을 켜서 모자라면 후보를 더 찾게 한다. SET LOCAL이라 트랜잭션 안에서만 적용된다
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
    const { rows } = await client.query<RetrievedChunk>(
      `SELECT content, title, source_url, 1 - (embedding <=> $1) AS similarity
       FROM doc_chunks
       WHERE source_url LIKE $3
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [embedding, k, `${DOCS_BASE_URL}${framework}/%`],
    );
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
