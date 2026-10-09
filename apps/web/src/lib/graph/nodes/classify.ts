import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { invokeStructured } from "../../llm";
import type { GraphStateType, GraphStateUpdate } from "../state";

// 분류와 독립 질문 작성을 한 번의 호출로 처리해 LLM 호출 수를 줄인다
const ClassifySchema = z.object({
  // 작은 모델은 "needsSearch"를 자주 false로 답해 검색을 건너뛰므로, 잡담 여부를 묻도록 뒤집었다
  isChitchat: z.boolean().describe("인사·감사·잡담처럼 문서가 전혀 필요 없는 메시지일 때만 true"),
  searchQuery: z
    .string()
    .describe("대화 맥락 없이도 이해되도록 마지막 질문을 풀어 쓴 독립 질문(사용자와 같은 언어). isChitchat이 true면 빈 문자열"),
});

// 검색을 건너뛰면 근거 없이 답(환각)하게 되므로, 애매하면 검색 쪽으로 기울인다
const PROMPT = `당신은 LangChain JS/TS 공식 문서 검색 챗봇의 라우터입니다.
대화의 마지막 사용자 메시지를 보고 문서 검색이 필요한지 판단하세요.
LangChain·LangGraph·에이전트·LLM·코드에 관한 질문은 모두 검색이 필요합니다(isChitchat: false).
인사, 감사, 잡담처럼 문서가 전혀 필요 없을 때만 isChitchat이 true이고, 애매하면 false로 하세요.
검색이 필요하면, "그거 예시는?" 같은 후속 질문도 앞선 대화를 반영해 혼자서 이해되는 질문으로 바꿔 searchQuery에 쓰세요.`;

export async function classify(state: GraphStateType): Promise<GraphStateUpdate> {
  const { isChitchat, searchQuery } = await invokeStructured(ClassifySchema, [
    new SystemMessage(PROMPT),
    ...state.messages,
  ]);
  // 체크포인터로 이전 턴 상태가 남아 있어도 이번 질문 기준으로 초기화
  return { needsSearch: !isChitchat, searchQuery, documents: [], retryCount: 0 };
}
