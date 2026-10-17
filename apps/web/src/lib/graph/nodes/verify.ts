import { AIMessage } from "@langchain/core/messages";
import { verifyAnswer } from "../../verify";
import { mergeResearched } from "../research";
import type { GraphStateType, GraphStateUpdate } from "../state";

// 답변의 TS 코드를 타입 검사해 결과를 답변 메시지에 붙인다. 자동 수정은 하지 않는다 (plan.md Phase 8).
// 에러가 출처 문서의 코드에도 있는지 비교하려고 generate와 같은 방식으로 출처 청크를 다시 합친다
export async function verify(state: GraphStateType): Promise<GraphStateUpdate> {
  const answer = state.messages[state.messages.length - 1];
  const documents = state.needsSearch ? mergeResearched(state.researched, state.subQueries) : [];
  try {
    const result = verifyAnswer(answer.text, documents.map((doc) => doc.content));
    if (!result.blocks) return {};
    // 같은 id의 메시지는 교체된다. 대화를 다시 불러올 때도 검증 결과를 보여주도록 체크포인트에 남긴다
    return {
      messages: [
        new AIMessage({
          id: answer.id,
          content: answer.content,
          additional_kwargs: { ...answer.additional_kwargs, verify: result },
        }),
      ],
    };
  } catch (error) {
    // 답변은 이미 스트리밍됐으므로 검증 실패로 요청 전체를 실패시키지 않는다
    console.error("verify failed", error);
    return {};
  }
}
