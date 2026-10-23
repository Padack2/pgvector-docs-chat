import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { checkpointer } from "../db/checkpointer";
import { store } from "../db/store";
import { clarify } from "./nodes/clarify";
import { classify } from "./nodes/classify";
import { generate } from "./nodes/generate";
import { verify } from "./nodes/verify";
import { research } from "./research";
import { GraphState, type GraphStateType } from "./state";

// 하위 질문마다 research를 하나씩 병렬 실행한다 (단일 주제 질문은 1개)
const toResearch = (state: GraphStateType) =>
  state.subQueries.map((question) => new Send("research", { question, framework: state.framework }));

// START → classify ─┬─(검색 불필요)──────────────────────────────────────────────────→ generate → verify → END
//                   ├─(프레임워크 애매)→ clarify(interrupt로 되물음) ─┐                     ↑
//                   └─(검색 필요)──────────────────────────────────────┴→ research × 하위 질문 수 ┘
// research는 retrieve → grade → rewrite 반복을 묶은 서브그래프 (research.ts). 모든 research가 끝나면 generate가 결과를 합쳐 답한다.
// verify는 답변의 TS 코드를 타입 검사한다 (LLM 호출 없음)
export const graph = new StateGraph(GraphState)
  .addNode("classify", classify)
  .addNode("clarify", clarify)
  .addNode("research", research)
  .addNode("generate", generate)
  .addNode("verify", verify)
  .addEdge(START, "classify")
  .addConditionalEdges(
    "classify",
    (state: GraphStateType) => {
      if (!state.needsSearch) return "generate";
      return state.frameworkCandidates.length >= 2 ? "clarify" : toResearch(state);
    },
    ["clarify", "research", "generate"],
  )
  .addConditionalEdges("clarify", toResearch, ["research"])
  .addEdge("research", "generate")
  .addEdge("generate", "verify")
  .addEdge("verify", END)
  // 대화 기록은 thread_id별 체크포인트로 저장된다 (요청에는 새 질문만 온다).
  // store는 대화를 넘어 유지할 사용자별 기억으로, configurable.user_id로 구분한다
  .compile({ checkpointer, store });
