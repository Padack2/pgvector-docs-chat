import { searchChunks, type RetrievedChunk } from "../../db/pgvector";
import type { ResearchStateType, ResearchStateUpdate } from "../state";

// 하위 질문 하나당 가져오는 청크 수. 합칠 때 섹션 중복을 빼도 답변 컨텍스트 상한을 채울 수 있게 넉넉히 (ADR-007)
const PER_QUERY = 10;

export async function retrieve(state: ResearchStateType): Promise<ResearchStateUpdate> {
  return { documents: await searchChunks(state.searchQuery, PER_QUERY, state.framework) };
}

// grade·generate 프롬프트에 넣는 형식. 번호는 generate가 출처를 [1]처럼 인용할 때 쓴다
export function formatDocuments(documents: RetrievedChunk[]): string {
  return documents
    .map((doc, i) => `[${i + 1}] ${doc.title} (${doc.source_url})\n${doc.content}`)
    .join("\n\n---\n\n");
}
