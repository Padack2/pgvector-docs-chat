import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { invokeStructured } from "../../llm";
import { FRAMEWORKS, type GraphStateType, type GraphStateUpdate } from "../state";

// 분류와 독립 질문 작성을 한 번의 호출로 처리해 LLM 호출 수를 줄인다
const ClassifySchema = z.object({
  // 작은 모델은 "needsSearch"를 자주 false로 답해 검색을 건너뛰므로, 잡담 여부를 묻도록 뒤집었다
  isChitchat: z.boolean().describe("인사·감사·잡담처럼 문서가 전혀 필요 없는 메시지일 때만 true"),
  searchQuery: z
    .string()
    .describe("대화 맥락 없이도 이해되도록 마지막 질문을 풀어 쓴 독립 질문(사용자와 같은 언어). isChitchat이 true면 빈 문자열"),
  subQueries: z
    .array(z.string())
    .describe("searchQuery를 주제별로 나눈 하위 질문 목록(1~3개, 사용자와 같은 언어). isChitchat이 true면 빈 배열"),
  frameworkCandidates: z
    .array(z.enum(FRAMEWORKS))
    .describe(
      "답이 프레임워크마다 달라지는데 어느 것인지 알 수 없을 때만 해당될 수 있는 프레임워크를 모두 나열. 그 외에는 빈 배열",
    ),
});

// 검색을 건너뛰면 근거 없이 답(환각)하게 되므로, 애매하면 검색 쪽으로 기울인다
const PROMPT = `당신은 LangChain JS/TS 공식 문서 검색 챗봇의 라우터입니다.
대화의 마지막 사용자 메시지를 보고 문서 검색이 필요한지 판단하세요.
LangChain·LangGraph·에이전트·LLM·코드에 관한 질문은 모두 검색이 필요합니다(isChitchat: false).
인사, 감사, 잡담처럼 문서가 전혀 필요 없을 때만 isChitchat이 true이고, 애매하면 false로 하세요.
검색이 필요하면, "그거 예시는?" 같은 후속 질문도 앞선 대화를 반영해 혼자서 이해되는 질문으로 바꿔 searchQuery에 쓰세요.

subQueries: 주제마다 따로 검색할 수 있도록 searchQuery를 나눈 하위 질문 목록입니다.
- 서로 다른 주제(기능·API·개념) 여러 개를 함께 묻거나 둘을 비교하면, 주제마다 혼자서 이해되는 질문 하나씩으로 나누세요 (최대 3개). 예: "checkpointer와 store는 뭐가 다르고 각각 언제 써?" → ["checkpointer는 무엇이고 언제 쓰나", "store는 무엇이고 언제 쓰나"]
- 주제가 하나면 searchQuery와 같은 질문 하나만 넣으세요. 한 주제의 여러 측면(예: "스트리밍 설정과 예시")은 나누지 않습니다.
- 질문에 밝힌 프레임워크·API 이름은 각 하위 질문에도 그대로 넣으세요.

frameworkCandidates: 문서는 langchain(createAgent·미들웨어), langgraph(StateGraph·그래프), deepagents(createDeepAgent)로 나뉘고,
메모리·스트리밍·human-in-the-loop·서브에이전트처럼 같은 주제가 여러 프레임워크에 따로 있습니다.
- 답이 프레임워크마다 다르고, 질문과 앞선 대화 어디에도 프레임워크를 알 단서(이름, createAgent·StateGraph 같은 API)가 없을 때만 후보를 모두 나열하세요. 예: "메모리는 어떻게 써?"
- 프레임워크를 밝혔거나 API 이름으로 알 수 있거나, 비교 질문이거나, 특정 프레임워크와 무관하면 빈 배열입니다. 예: "createAgent에 메모리 추가", "LangChain과 LangGraph 차이"
- 확실하지 않으면 빈 배열로 하세요. 사용자에게 되묻는 것은 꼭 필요할 때만 합니다.`;

export async function classify(state: GraphStateType): Promise<GraphStateUpdate> {
  const { isChitchat, searchQuery, subQueries, frameworkCandidates } = await invokeStructured(ClassifySchema, [
    new SystemMessage(PROMPT),
    ...state.messages,
  ]);
  // 체크포인터로 이전 턴 상태가 남아 있어도 이번 질문 기준으로 초기화
  return {
    needsSearch: !isChitchat,
    searchQuery,
    // 모델이 빈 배열을 내면 searchQuery 하나로 검색한다
    subQueries: isChitchat ? [] : subQueries.length > 0 ? subQueries.slice(0, 3) : [searchQuery],
    frameworkCandidates: isChitchat ? [] : Array.from(new Set(frameworkCandidates)),
    framework: null,
    documents: [],
    retryCount: 0,
  };
}
