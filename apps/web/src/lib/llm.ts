import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { InteropZodType } from "@langchain/core/utils/types";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";

// GEMINI_MODEL이 실패하면 순서대로 다음 모델을 시도한다.
// 2026-10-09 gemini-3.8-flash가 에러 없이 응답을 멈추고 3.5-flash도 503(high demand)을 섞어 내는 일이 있었다
const FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];

// 모델이 에러 없이 멈추면 fallback이 시작되지 않으므로 호출마다 시간 제한을 둔다.
// 구조화 출력(분류·평가·재작성)은 짧고, 답변은 스트리밍이 끝날 때까지 포함이라 더 길게 준다
const STRUCTURED_TIMEOUT_MS = 15_000;
const ANSWER_TIMEOUT_MS = 30_000;

// 실패한 모델은 잠시 건너뛴다. 멈춘 모델을 노드마다 다시 기다리면 요청 전체 시간 제한(route.ts)을 금방 넘긴다
const COOLDOWN_MS = 60_000;
const failedAt = new Map<string, number>();

function geminiModelNames(): string[] {
  const names = Array.from(new Set([process.env.GEMINI_MODEL ?? "gemini-3.8-flash", ...FALLBACK_MODELS]));
  const healthy = names.filter((name) => Date.now() - (failedAt.get(name) ?? 0) > COOLDOWN_MS);
  // 전부 쉬는 중이면 아무것도 안 하고 실패하기보다 처음부터 다시 시도
  return healthy.length > 0 ? healthy : names;
}

async function invokeWithFallback<T>(
  build: (model: BaseChatModel) => Runnable<BaseMessage[], T>,
  messages: BaseMessage[],
  timeoutMs: number,
): Promise<T> {
  // LLM_PROVIDER=ollama 이면 로컬 Ollama 하나만 사용 (로컬 개발용이라 fallback·시간 제한 없음)
  if (process.env.LLM_PROVIDER === "ollama") {
    const model = new ChatOllama({
      model: process.env.OLLAMA_MODEL ?? "llama3.1",
      baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    });
    return build(model).invoke(messages);
  }

  let lastError: unknown;
  for (const name of geminiModelNames()) {
    // 같은 모델로 재시도하며 기다리는 대신 바로 다음 모델로 넘어간다
    const model = new ChatGoogleGenerativeAI({ model: name, apiKey: process.env.GEMINI_API_KEY, maxRetries: 0 });
    try {
      return await build(model).invoke(messages, { timeout: timeoutMs });
    } catch (error) {
      console.warn(`LLM ${name} failed, trying next model:`, String(error).slice(0, 200));
      failedAt.set(name, Date.now());
      lastError = error;
    }
  }
  throw lastError;
}

export function invokeChat(messages: BaseMessage[]) {
  return invokeWithFallback((model) => model, messages, ANSWER_TIMEOUT_MS);
}

export function invokeStructured<T extends Record<string, unknown>>(
  schema: InteropZodType<T>,
  messages: BaseMessage[],
) {
  return invokeWithFallback((model) => model.withStructuredOutput(schema), messages, STRUCTURED_TIMEOUT_MS);
}
