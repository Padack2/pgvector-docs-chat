import { END, START, StateGraph } from "@langchain/langgraph";
import { grade } from "./nodes/grade";
import { retrieve } from "./nodes/retrieve";
import { rewrite } from "./nodes/rewrite";
import { ResearchState, type ResearchStateType } from "./state";

// 재검색 최대 횟수. 다 쓰면 마지막 검색 결과로 답변한다
const MAX_RETRIES = 3;

// 질문 하나에 답할 문서를 찾는 서브그래프. 체크포인터는 부모 그래프 것을 물려받는다
// START → retrieve → grade ─┬─(충분/한도)→ END
//            ↑              └─(불충분)→ rewrite ─┐
//            └──────────────────────────────────┘
export const research = new StateGraph(ResearchState)
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
