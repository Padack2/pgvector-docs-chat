import type { BaseMessage } from "@langchain/core/messages";
import type { StateSnapshot } from "@langchain/langgraph";
import { graph } from "./graph";

export type Source = { title: string; url: string };

export type ThreadMessage =
  | {
      role: "user";
      content: string;
      // 이 질문을 수정·재시도할 때 fork할 체크포인트 (질문이 들어가기 직전 상태)
      forkFrom: string;
      // 같은 위치의 분기들. 각 분기의 마지막 체크포인트 id, 오래된 순
      branches: string[];
      branchIndex: number;
    }
  | { role: "assistant"; content: string; sources: Source[] };

export type ThreadView = {
  messages: ThreadMessage[];
  // 화면에 보이는 분기의 마지막 체크포인트. 다음 질문은 여기서 이어간다
  checkpointId: string | null;
};

// 체크포인트 구조 (턴마다):
//   input 체크포인트 (질문이 들어가기 직전 상태, 질문은 pending write) → loop 체크포인트들 (노드 실행마다)
// 질문을 수정하면 그 턴의 input 체크포인트의 부모에서 fork해 형제 input 체크포인트가 생긴다.
// 첫 질문은 input 체크포인트에 부모가 없어서 그 체크포인트 자체에서 fork한다
const idOf = (s: StateSnapshot) => s.config.configurable?.checkpoint_id as string;
const parentIdOf = (s: StateSnapshot) => s.parentConfig?.configurable?.checkpoint_id as string | undefined;
const isInput = (s: StateSnapshot) => s.metadata?.source === "input";
const messagesOf = (s: StateSnapshot) => (s.values.messages ?? []) as BaseMessage[];
const byCreatedAt = (a: StateSnapshot, b: StateSnapshot) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "");

export async function loadThread(threadId: string, checkpointId?: string): Promise<ThreadView | null> {
  const all: StateSnapshot[] = [];
  for await (const snapshot of graph.getStateHistory({ configurable: { thread_id: threadId } })) all.push(snapshot);
  if (all.length === 0) return checkpointId ? null : { messages: [], checkpointId: null };

  const byId = new Map(all.map((s) => [idOf(s), s]));
  const children = new Map<string, StateSnapshot[]>();
  for (const s of all) {
    const parentId = parentIdOf(s);
    if (parentId) children.set(parentId, [...(children.get(parentId) ?? []), s]);
  }
  const newest = (list: StateSnapshot[]) => [...list].sort(byCreatedAt)[list.length - 1];
  const loopChildren = (s: StateSnapshot) => (children.get(idOf(s)) ?? []).filter((c) => !isInput(c));
  const forkPointOf = (turnStart: StateSnapshot) => parentIdOf(turnStart) ?? idOf(turnStart);

  // 질문이 실제로 들어간 input 체크포인트만 턴의 시작이다.
  // 첫 질문을 수정한 분기에서는 원래 턴의 input 체크포인트가 경로에 남지만 그 질문은 반영되지 않는다
  const turnStarts = all.filter((s) => isInput(s) && loopChildren(s).length > 0);

  // 분기의 끝: 턴 시작에서 그 질문이 반영된 loop로 들어간 뒤, 갈림길마다 가장 최근 분기를 따라간다
  const leafOf = (turnStart: StateSnapshot) => {
    let current = newest(loopChildren(turnStart));
    for (let next = children.get(idOf(current)); next; next = children.get(idOf(current))) current = newest(next);
    return current;
  };
  // 답변까지 끝난 분기인지: 그 턴의 질문과 답변 두 메시지가 분기 끝에 남아 있는지
  const isAnswered = (turnStart: StateSnapshot) =>
    messagesOf(leafOf(turnStart)).length >= messagesOf(turnStart).length + 2;

  // checkpointId가 없으면 가장 최근 체크포인트 (getStateHistory는 최신순)
  const leaf = checkpointId ? byId.get(checkpointId) : all[0];
  if (!leaf) return null;

  const path: StateSnapshot[] = [];
  for (let s: StateSnapshot | undefined = leaf; s; s = byId.get(parentIdOf(s) ?? "")) path.unshift(s);
  const pathTurnStarts = path.filter((s, i) => isInput(s) && path[i + 1] && !isInput(path[i + 1]));

  let turn = 0;
  const messages = messagesOf(leaf).map((message): ThreadMessage => {
    if (message.getType() !== "human") {
      const sources = (message.additional_kwargs?.sources ?? []) as Source[];
      return { role: "assistant", content: message.text, sources };
    }
    const start = pathTurnStarts[turn++];
    const forkFrom = forkPointOf(start);
    // 답변 없이 실패한 분기는 재시도로 대체된 것이라 숨긴다 (지금 보고 있는 분기는 제외)
    const siblings = turnStarts
      .filter((s) => forkPointOf(s) === forkFrom && (s === start || isAnswered(s)))
      .sort(byCreatedAt);
    return {
      role: "user",
      content: message.text,
      forkFrom,
      branches: siblings.map((s) => idOf(leafOf(s))),
      branchIndex: siblings.indexOf(start),
    };
  });

  return { messages, checkpointId: idOf(leaf) };
}
