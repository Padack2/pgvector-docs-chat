// 되묻기 판단 평가: eval/clarify-questions.json의 대화마다 classify 노드를 실행해, 되물어야 할 때 묻고 아닐 때 묻지 않는지 잰다.
// - messages는 user / assistant가 번갈아 나오는 대화이고 마지막이 이번 질문
// - 되묻기 = classify가 프레임워크 후보를 2개 이상 냈을 때 (그래프의 clarify 분기 조건과 같음)
// LLM을 질문마다 1번 호출한다. 모델은 apps/web/.env.local 설정을 따르고, 실행할 때 환경 변수로 바꿀 수 있다
//   예: LLM_PROVIDER=ollama pnpm --filter scripts eval-clarify
import { readFile } from "node:fs/promises";
import { classify } from "../apps/web/src/lib/graph/nodes/classify";
import type { GraphStateType } from "../apps/web/src/lib/graph/state";

type Case = { id: string; shouldAsk: boolean; messages: string[] };

const cases: Case[] = JSON.parse(await readFile(new URL("eval/clarify-questions.json", import.meta.url), "utf8"));
const model =
  process.env.LLM_PROVIDER === "ollama" ? `ollama:${process.env.OLLAMA_MODEL}` : `gemini:${process.env.GEMINI_MODEL}`;
console.log(`model: ${model} (실패하면 llm.ts의 다음 모델로 넘어감)\n`);
// Gemini 무료 티어는 모델당 분당 5요청이라 호출 사이를 띄운다
const DELAY_MS = process.env.LLM_PROVIDER === "ollama" ? 0 : 13_000;

const results = [];
for (const [i, c] of cases.entries()) {
  if (i > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  // scripts 패키지는 @langchain/core에 의존하지 않으므로 메시지를 {role, content}로 넘긴다 (LangChain이 변환)
  const messages = c.messages.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));
  const { frameworkCandidates = [] } = await classify({ messages } as unknown as GraphStateType);
  const asked = frameworkCandidates.length >= 2;
  results.push({ ...c, asked, frameworkCandidates });
  console.log(
    `${asked === c.shouldAsk ? "ok  " : "MISS"} ${c.id} asked=${asked} [${frameworkCandidates.join(", ")}]  ${c.messages.at(-1)}`,
  );
}

const count = (f: (r: (typeof results)[number]) => boolean) => results.filter(f).length;
const askedRight = count((r) => r.asked && r.shouldAsk);
const shouldAsk = count((r) => r.shouldAsk);
const asked = count((r) => r.asked);
console.log(`
accuracy  ${count((r) => r.asked === r.shouldAsk)}/${results.length}
recall    ${askedRight}/${shouldAsk}  (되물어야 할 질문 중 실제로 되물은 비율)
precision ${askedRight}/${asked}  (되물은 질문 중 되물어야 했던 비율 — 낮으면 불필요하게 귀찮게 함)`);
