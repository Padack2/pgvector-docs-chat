// 측정용 예시 코드: 정상 2개, 옛 API(MemoryStore)를 쓰는 에러 1개
export const samples: Record<string, string> = {
  langgraph: `
import { StateGraph, StateSchema, START, END, MemorySaver } from "@langchain/langgraph";
import { z } from "zod";

const State = new StateSchema({ count: z.number() });
const graph = new StateGraph(State)
  .addNode("inc", (s) => ({ count: s.count + 1 }))
  .addEdge(START, "inc")
  .addEdge("inc", END)
  .compile({ checkpointer: new MemorySaver() });

const result = await graph.invoke({ count: 0 }, { configurable: { thread_id: "1" } });
console.log(result.count);
`,
  agent: `
import { createAgent, tool } from "langchain";
import { z } from "zod";

const getWeather = tool(async ({ city }) => \`\${city}: sunny\`, {
  name: "get_weather",
  description: "Get weather",
  schema: z.object({ city: z.string() }),
});
const agent = createAgent({ model: "openai:gpt-4o", tools: [getWeather] });
await agent.invoke({ messages: [{ role: "user", content: "weather in Seoul?" }] });
`,
  oldApi: `
import { MemoryStore } from "@langchain/langgraph";
const store = new MemoryStore();
`,
};
