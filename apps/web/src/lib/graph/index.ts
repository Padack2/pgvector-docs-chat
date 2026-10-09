import { END, START, StateGraph } from "@langchain/langgraph";
import { checkpointer } from "../db/checkpointer";
import { classify } from "./nodes/classify";
import { generate } from "./nodes/generate";
import { grade } from "./nodes/grade";
import { retrieve } from "./nodes/retrieve";
import { rewrite } from "./nodes/rewrite";
import { GraphState, type GraphStateType } from "./state";

// 재검색 최대 횟수. 다 쓰면 마지막 검색 결과로 답변한다
const MAX_RETRIES = 3;

// START → classify ─┬─(검색 불필요)──────────────────────────→ generate → END
//                   └─(검색 필요)→ retrieve → grade ─┬─(충분/한도)→ generate
//                                    ↑              └─(불충분)→ rewrite ─┐
//                                    └───────────────────────────────────┘
export const graph = new StateGraph(GraphState)
  .addNode("classify", classify)
  .addNode("retrieve", retrieve)
  .addNode("grade", grade)
  .addNode("rewrite", rewrite)
  .addNode("generate", generate)
  .addEdge(START, "classify")
  .addConditionalEdges("classify", (state: GraphStateType) => (state.needsSearch ? "retrieve" : "generate"), [
    "retrieve",
    "generate",
  ])
  .addEdge("retrieve", "grade")
  .addConditionalEdges(
    "grade",
    (state: GraphStateType) => (state.isSufficient || state.retryCount >= MAX_RETRIES ? "generate" : "rewrite"),
    ["generate", "rewrite"],
  )
  .addEdge("rewrite", "retrieve")
  .addEdge("generate", END)
  // 대화 기록은 thread_id별 체크포인트로 저장된다 (요청에는 새 질문만 온다)
  .compile({ checkpointer });
