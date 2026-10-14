import { interrupt } from "@langchain/langgraph";
import { FRAMEWORKS, type Framework, type GraphStateType, type GraphStateUpdate } from "../state";

export const FRAMEWORK_LABELS: Record<Framework, string> = {
  langchain: "LangChain (createAgent)",
  langgraph: "LangGraph",
  deepagents: "Deep Agents",
};

// interrupt로 클라이언트에 보내는 값. 선택한 value가 재개(Command resume) 값으로 돌아온다
export type ClarifyRequest = { question: string; options: { value: string; label: string }[] };

// 질문이 여러 프레임워크에 해당될 때 그래프를 멈추고 어느 것인지 묻는다.
// 재개되면 이 노드가 처음부터 다시 실행되므로 interrupt 앞에 부수 효과(LLM 호출 등)를 두지 않는다
export function clarify(state: GraphStateType): GraphStateUpdate {
  const choice = interrupt<ClarifyRequest, string>({
    question: "어느 프레임워크 기준으로 답할까요?",
    options: [
      ...state.frameworkCandidates.map((framework) => ({ value: framework, label: FRAMEWORK_LABELS[framework] })),
      { value: "all", label: "구분 없이 찾기" },
    ],
  });
  // "all"이나 알 수 없는 값이면 전체 문서에서 찾는다
  const framework = FRAMEWORKS.find((f) => f === choice) ?? null;
  // classify는 되물을 질문을 대개 프레임워크별 하위 질문("LangChain에서 …", "LangGraph에서 …")으로 나눈다.
  // 하나를 고르면 나머지는 고른 문서에서 헛검색되므로 독립 질문 하나로 검색하고, "all"이면 프레임워크별 검색을 그대로 둔다.
  // classify 프롬프트로 나누지 말라고 해도 대부분 나눠서(eval-clarify 2회, 되물은 질문 중 16/18·15/19) 코드에서 처리한다 (ADR-007)
  return framework ? { framework, subQueries: [state.searchQuery] } : { framework };
}
