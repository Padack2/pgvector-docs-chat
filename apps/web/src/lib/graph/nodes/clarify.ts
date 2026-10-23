import { interrupt, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { FRAMEWORKS, type Framework, type GraphStateType, type GraphStateUpdate } from "../state";

export const FRAMEWORK_LABELS: Record<Framework, string> = {
  langchain: "LangChain (createAgent)",
  langgraph: "LangGraph",
  deepagents: "Deep Agents",
};

// interrupt로 클라이언트에 보내는 값. 선택한 value가 재개(Command resume) 값으로 돌아온다
export type ClarifyRequest = { question: string; options: { value: string; label: string }[] };

// 되묻기에서 고른 프레임워크를 사용자별로 기억하는 Store 위치. user_id는 route가 익명 쿠키로 넘긴다
const MEMORY_KEY = "framework";

// 질문이 여러 프레임워크에 해당될 때 그래프를 멈추고 어느 것인지 묻는다.
// 재개되면 이 노드가 처음부터 다시 실행되므로 interrupt 앞에는 읽기(Store 조회)만 두고 LLM 호출·쓰기를 두지 않는다
export async function clarify(state: GraphStateType, config: LangGraphRunnableConfig): Promise<GraphStateUpdate> {
  const userId = config.configurable?.user_id as string | undefined;
  const namespace = userId ? ["users", userId] : undefined;

  // 기억된 프레임워크가 이번 후보에 있으면 되묻지 않고 적용한다. 후보에 없으면 지금 질문에 맞지 않으므로 되묻는다.
  // 재개 실행이나 "변경"(기억 무시 재실행)에서는 route가 ignore_memory를 넘긴다: 이미 되물었으므로 사용자의 선택을 따라야 한다
  if (config.store && namespace && !config.configurable?.ignore_memory) {
    const item = await config.store.get(namespace, MEMORY_KEY);
    const remembered = FRAMEWORKS.find((f) => f === item?.value.framework);
    if (remembered && state.frameworkCandidates.includes(remembered)) {
      return { framework: remembered, frameworkRemembered: true, subQueries: [state.searchQuery] };
    }
  }

  const choice = interrupt<ClarifyRequest, string>({
    question: "어느 프레임워크 기준으로 답할까요?",
    options: [
      ...state.frameworkCandidates.map((framework) => ({ value: framework, label: FRAMEWORK_LABELS[framework] })),
      { value: "all", label: "구분 없이 찾기" },
    ],
  });
  // "all"이나 알 수 없는 값이면 전체 문서에서 찾는다
  const framework = FRAMEWORKS.find((f) => f === choice) ?? null;
  // 특정 프레임워크를 고르면 다음 대화부터 적용하고, "구분 없이 찾기"를 고르면 기억을 지운다
  if (config.store && namespace) {
    if (framework) await config.store.put(namespace, MEMORY_KEY, { framework });
    else await config.store.delete(namespace, MEMORY_KEY);
  }
  // classify는 되물을 질문을 대개 프레임워크별 하위 질문("LangChain에서 …", "LangGraph에서 …")으로 나눈다.
  // 하나를 고르면 나머지는 고른 문서에서 헛검색되므로 독립 질문 하나로 검색하고, "all"이면 프레임워크별 검색을 그대로 둔다.
  // classify 프롬프트로 나누지 말라고 해도 대부분 나눠서(eval-clarify 2회, 되물은 질문 중 16/18·15/19) 코드에서 처리한다 (ADR-007)
  return framework ? { framework, subQueries: [state.searchQuery] } : { framework };
}
