import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";

// LLM_PROVIDER=ollama 이면 로컬 Ollama, 그 외에는 Gemini 사용
export function getChatModel() {
  if (process.env.LLM_PROVIDER === "ollama") {
    return new ChatOllama({
      model: process.env.OLLAMA_MODEL ?? "llama3.1",
      baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    });
  }

  return new ChatGoogleGenerativeAI({
    model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
    apiKey: process.env.GEMINI_API_KEY,
  });
}
