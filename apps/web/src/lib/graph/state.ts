import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { RetrievedChunk } from "../db/pgvector";

// 노드는 바꿀 필드만 반환하고, 별도 reducer가 없으면 마지막 값으로 덮어쓴다
export const GraphState = Annotation.Root({
  // 대화 기록: 마지막 HumanMessage가 이번 질문, generate가 AIMessage로 답변을 덧붙인다
  ...MessagesAnnotation.spec,
  // 의도 분류 결과: false면 검색 없이 바로 답변
  needsSearch: Annotation<boolean>,
  // 실제 검색에 쓰는 쿼리: 후속 질문("그거 예시는?")을 대화 맥락으로 풀어 쓴 독립 질문, 재검색 때마다 재작성됨
  searchQuery: Annotation<string>,
  // 마지막 검색 결과 (재검색 시 교체)
  documents: Annotation<RetrievedChunk[]>,
  // 품질 판단 결과: false면 쿼리 재작성 후 재검색
  isSufficient: Annotation<boolean>,
  // 재검색 횟수 (최대 3회)
  retryCount: Annotation<number>,
});

export type GraphStateType = typeof GraphState.State;
export type GraphStateUpdate = typeof GraphState.Update;
