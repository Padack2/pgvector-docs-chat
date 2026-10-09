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

export async function searchChunks(query: string, k = 5): Promise<RetrievedChunk[]> {
  return searchByEmbedding(await embedQuery(query), k);
}

// 평가 스크립트(scripts/eval.ts)는 질문 임베딩을 캐시해 두고 이 함수로 같은 검색 쿼리를 실행한다
export async function searchByEmbedding(queryEmbedding: number[], k: number): Promise<RetrievedChunk[]> {
  const embedding = pgvector.toSql(queryEmbedding);
  const { rows } = await pool.query<RetrievedChunk>(
    `SELECT content, title, source_url, 1 - (embedding <=> $1) AS similarity
     FROM doc_chunks
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [embedding, k],
  );
  return rows;
}
