import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { invokeStructured } from "../../llm";
import type { GraphStateType, GraphStateUpdate } from "../state";

const RewriteSchema = z.object({
  searchQuery: z.string().describe("이전 쿼리와 다른 표현·키워드로 다시 쓴 검색 쿼리"),
});

export async function rewrite(state: GraphStateType): Promise<GraphStateUpdate> {
  // 엉뚱한 문서가 나왔다는 단서가 되도록 이전 결과의 제목을 함께 준다
  const titles = Array.from(new Set(state.documents.map((doc) => doc.title))).join(", ");
  const prompt = `당신은 LangChain JS/TS 공식 문서 검색 쿼리 작성자입니다.
이전 쿼리로는 대화의 마지막 질문에 답할 문서를 찾지 못했습니다.
질문의 의도는 유지하되, 문서에 쓰였을 법한 용어(영어 API·클래스 이름 등)를 활용해 쿼리를 다시 쓰세요.

이전 쿼리: ${state.searchQuery}
이전 검색 결과 제목: ${titles}`;

  const { searchQuery } = await invokeStructured(RewriteSchema, [new SystemMessage(prompt), ...state.messages]);
  return { searchQuery, retryCount: state.retryCount + 1 };
}
