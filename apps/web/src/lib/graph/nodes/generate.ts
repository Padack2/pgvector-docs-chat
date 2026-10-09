import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { invokeChat } from "../../llm";
import type { GraphStateType, GraphStateUpdate } from "../state";
import { formatDocuments } from "./retrieve";

const BASE_PROMPT = `당신은 LangChain JS/TS 공식 문서를 기반으로 답하는 챗봇입니다. 사용자의 언어로 답하세요.`;

export async function generate(state: GraphStateType): Promise<GraphStateUpdate> {
  const prompt = state.needsSearch
    ? `${BASE_PROMPT}
아래 문서 내용만 근거로 답하고, 근거로 쓴 문서는 [1]처럼 번호로 인용하세요.
문서에 답이 없으면 추측하지 말고 문서에서 찾지 못했다고 말하세요.

문서:
${formatDocuments(state.documents)}`
    : `${BASE_PROMPT}
이번 메시지는 문서 검색이 필요 없는 대화입니다. 짧게 응대하고, 필요하면 LangChain 관련 질문을 하도록 안내하세요.`;

  const answer = await invokeChat([new SystemMessage(prompt), ...state.messages]);
  // 대화를 다시 불러올 때 출처도 보여주도록 답변 메시지에 함께 저장한다 (체크포인트에 남음)
  const sources = state.needsSearch ? state.documents.map((doc) => ({ title: doc.title, url: doc.source_url })) : [];
  return { messages: [new AIMessage({ id: answer.id, content: answer.content, additional_kwargs: { sources } })] };
}
