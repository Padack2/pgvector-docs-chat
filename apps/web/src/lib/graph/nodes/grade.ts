import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { invokeStructured } from "../../llm";
import type { GraphStateType, GraphStateUpdate } from "../state";
import { formatDocuments } from "./retrieve";

const GradeSchema = z.object({
  isSufficient: z.boolean().describe("검색 결과만으로 마지막 질문에 답할 수 있으면 true"),
});

// 청크마다 따로 평가하지 않고 결과 전체를 한 번에 판단한다 (LLM 호출 1회)
export async function grade(state: GraphStateType): Promise<GraphStateUpdate> {
  const prompt = `당신은 검색 결과 평가자입니다.
아래 검색 결과에 대화의 마지막 질문에 답하는 데 필요한 정보가 들어 있는지 판단하세요.
일부 관련 있는 정도가 아니라, 실제로 답을 쓸 수 있을 때만 true입니다.

검색 결과:
${formatDocuments(state.documents)}`;

  const { isSufficient } = await invokeStructured(GradeSchema, [new SystemMessage(prompt), ...state.messages]);
  return { isSufficient };
}
