"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnswerMarkdown, type Source } from "@/components/AnswerMarkdown";

type Message = { role: "user" | "assistant"; content: string; sources?: Source[]; error?: string };

// /api/chat의 NDJSON 이벤트 (route.ts 주석 참고)
type ChatEvent =
  | { type: "token"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "error"; message: string };

const EXAMPLES = [
  "createAgent에 툴은 어떻게 넣어?",
  "LangGraph에서 대화 기록을 유지하려면?",
  "Deep Agents는 일반 에이전트와 뭐가 달라?",
];

async function streamChat(history: Message[], onEvent: (event: ChatEvent) => void) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
  });
  if (!res.ok || !res.body) {
    const { error } = await res.json().catch(() => ({ error: `서버가 요청을 처리하지 못했습니다 (HTTP ${res.status}).` }));
    onEvent({ type: "error", message: error });
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  // 네트워크 조각이 줄 중간에서 끊길 수 있으므로 마지막 미완성 줄은 다음 조각과 합친다
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) if (line) onEvent(JSON.parse(line));
  }
}

// 답변의 [n]은 sources[n-1]을 가리킨다. 같은 페이지의 청크가 여러 개면 번호를 모아 한 줄로 보여준다
function groupSources(sources: Source[]) {
  const groups = new Map<string, { title: string; numbers: number[] }>();
  sources.forEach((source, i) => {
    const group = groups.get(source.url) ?? { title: source.title, numbers: [] };
    group.numbers.push(i + 1);
    groups.set(source.url, group);
  });
  return Array.from(groups, ([url, group]) => ({ url, ...group }));
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-danger-line bg-danger-bg px-4 py-3 text-danger-text">
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className="mt-0.5 size-5 shrink-0">
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
          clipRule="evenodd"
        />
      </svg>
      <div className="space-y-0.5">
        <p className="font-semibold">답변을 받지 못했습니다</p>
        <p className="text-sm leading-relaxed">{message}</p>
      </div>
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 스트리밍 중인 마지막 assistant 메시지만 갱신
  const updateLast = (update: (message: Message) => Message) =>
    setMessages((prev) => [...prev.slice(0, -1), update(prev[prev.length - 1])]);

  async function send(question: string) {
    if (!question || isLoading) return;

    const history: Message[] = [...messages, { role: "user", content: question }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setIsLoading(true);
    try {
      await streamChat(history, (event) => {
        if (event.type === "token") updateLast((m) => ({ ...m, content: m.content + event.text }));
        else if (event.type === "sources") updateLast((m) => ({ ...m, sources: event.sources }));
        else updateLast((m) => ({ ...m, error: event.message }));
      });
    } catch {
      updateLast((m) => ({ ...m, error: "서버에 연결하지 못했습니다. 개발 서버가 켜져 있는지 확인하세요." }));
    } finally {
      setIsLoading(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    send(input.trim());
  }

  return (
    <main className="mx-auto flex h-dvh max-w-[44rem] flex-col px-4 sm:px-6">
      <header className="flex items-baseline justify-between gap-4 border-b border-line py-4">
        <h1 className="text-[17px] font-semibold tracking-tight">LangChain Docs Chat</h1>
        <p className="text-sm text-muted">JS/TS 공식 문서 기준</p>
      </header>

      <div className="flex-1 space-y-8 overflow-y-auto py-8">
        {messages.length === 0 && (
          <section className="pt-[12vh]">
            <h2 className="text-2xl font-semibold leading-snug tracking-tight sm:text-[28px]">
              LangChain을 쓰다 막힌 부분을 물어보세요.
            </h2>
            <p className="mt-3 leading-relaxed text-muted">
              LangChain, LangGraph, Deep Agents 공식 문서에서 근거를 찾아 답하고, 어느 문서를 참고했는지 함께 보여 줍니다.
            </p>
            <div className="mt-8 flex flex-col items-start gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  onClick={() => send(example)}
                  className="rounded-lg border border-line bg-surface px-4 py-2.5 text-left text-[15px] hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {example}
                </button>
              ))}
            </div>
          </section>
        )}

        {messages.map((message, i) =>
          message.role === "user" ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 leading-relaxed">
                {message.content}
              </p>
            </div>
          ) : (
            <article key={i} className="space-y-4">
              {message.content ? (
                <AnswerMarkdown content={message.content} sources={message.sources} />
              ) : (
                !message.error && (
                  <p className="flex items-center gap-2 text-muted">
                    <span className="size-2 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden />
                    문서를 찾고 있어요
                  </p>
                )
              )}
              {message.error && <ErrorNotice message={message.error} />}
              {message.sources && message.sources.length > 0 && (
                <div className="border-t border-line pt-3">
                  <h3 className="mb-2 text-sm text-muted">참고한 문서</h3>
                  <ul className="space-y-1.5 text-sm">
                    {groupSources(message.sources).map((source) => (
                      <li key={source.url} className="flex items-start gap-2">
                        <span className="shrink-0 pt-px font-mono text-[11px] text-muted">
                          {source.numbers.join(", ")}
                        </span>
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-line underline-offset-4 hover:text-accent hover:decoration-accent"
                        >
                          {source.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ),
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="pb-4 pt-2 sm:pb-6">
        <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-1.5 pl-4 focus-within:border-accent">
          <label htmlFor="question" className="sr-only">
            질문
          </label>
          <input
            id="question"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="질문을 입력하세요"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent py-2 outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="rounded-lg bg-accent px-4 py-2 font-semibold text-surface disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            보내기
          </button>
        </div>
      </form>
    </main>
  );
}
