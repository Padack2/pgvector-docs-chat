import { searchChunks, type RetrievedChunk } from "../../db/pgvector";
import type { GraphStateType, GraphStateUpdate } from "../state";

export async function retrieve(state: GraphStateType): Promise<GraphStateUpdate> {
  return { documents: await searchChunks(state.searchQuery, 5, state.framework) };
}

// grade·generate 프롬프트에 넣는 형식. 번호는 generate가 출처를 [1]처럼 인용할 때 쓴다
export function formatDocuments(documents: RetrievedChunk[]): string {
  return documents
    .map((doc, i) => `[${i + 1}] ${doc.title} (${doc.source_url})\n${doc.content}`)
    .join("\n\n---\n\n");
}
