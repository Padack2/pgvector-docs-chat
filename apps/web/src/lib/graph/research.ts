import { END, START, StateGraph } from "@langchain/langgraph";
import type { RetrievedChunk } from "../db/pgvector";
import { grade } from "./nodes/grade";
import { retrieve } from "./nodes/retrieve";
import { rewrite } from "./nodes/rewrite";
import { type Framework, type GraphStateUpdate, type ResearchResult, ResearchState, type ResearchStateType } from "./state";

// 재검색 최대 횟수. 다 쓰면 마지막 검색 결과로 답변한다
const MAX_RETRIES = 3;
// 하위 질문별 결과를 합친 답변 컨텍스트의 상한 (ADR-007)
const MAX_DOCUMENTS = 8;

// 하위 질문 하나에 답할 문서를 찾는 서브그래프. 체크포인터는 부모 그래프 것을 물려받는다
// START → retrieve → grade ─┬─(충분/한도)→ END
//            ↑              └─(불충분)→ rewrite ─┐
//            └──────────────────────────────────┘
const researchGraph = new StateGraph(ResearchState)
  .addNode("retrieve", retrieve)
  .addNode("grade", grade)
  .addNode("rewrite", rewrite)
  .addEdge(START, "retrieve")
  .addEdge("retrieve", "grade")
  .addConditionalEdges(
    "grade",
    (state: ResearchStateType) => (state.isSufficient || state.retryCount >= MAX_RETRIES ? END : "rewrite"),
    [END, "rewrite"],
  )
  .addEdge("rewrite", "retrieve")
  .compile();

// 부모 그래프의 research 노드. Send로 하위 질문마다 따로 실행되고, 결과는 researched reducer에 하나씩 쌓인다.
// 서브그래프의 재검색 상태(searchQuery·retryCount 등)는 부모로 올리지 않는다
export async function research(input: { question: string; framework: Framework | null }): Promise<GraphStateUpdate> {
  const { documents } = await researchGraph.invoke({ ...input, searchQuery: input.question, retryCount: 0 });
  return { researched: [{ question: input.question, documents }] };
}

// 하위 질문별 결과를 1위끼리, 2위끼리 번갈아 합치고, 같은 섹션의 청크는 먼저 나온 것만 남겨 상한까지 자른다 (ADR-007).
// 병렬 실행은 끝나는 순서가 매번 달라서 하위 질문 순서로 정렬한 뒤 합친다
export function mergeResearched(researched: ResearchResult[], subQueries: string[]): RetrievedChunk[] {
  const lists = [...researched]
    .sort((a, b) => subQueries.indexOf(a.question) - subQueries.indexOf(b.question))
    .map((result) => result.documents);
  const merged: RetrievedChunk[] = [];
  const seen = new Set<string>();
  for (let rank = 0; rank < Math.max(0, ...lists.map((list) => list.length)); rank++) {
    for (const list of lists) {
      const chunk = list[rank];
      // 청크 첫 줄이 "페이지 제목 > 섹션 경로"라 URL과 합치면 섹션을 구분할 수 있다
      const section = chunk && `${chunk.source_url}#${chunk.content.split("\n", 1)[0]}`;
      if (!chunk || seen.has(section)) continue;
      seen.add(section);
      merged.push(chunk);
    }
  }
  return merged.slice(0, MAX_DOCUMENTS);
}
