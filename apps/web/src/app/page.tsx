"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnswerMarkdown, type Source } from "@/components/AnswerMarkdown";

// 그래프 노드가 끝날 때마다 오는 진행 상황 (route.ts 주석 참고)
type Step =
  | { node: "classify"; needsSearch: boolean; searchQuery: string }
  | { node: "retrieve"; count: number }
  | { node: "grade"; isSufficient: boolean }
  | { node: "rewrite"; searchQuery: string };

type Message = { role: "user" | "assistant"; content: string; steps?: Step[]; sources?: Source[]; error?: string };

// /api/chat의 NDJSON 이벤트 (route.ts 주석 참고)
type ChatEvent =
  | ({ type: "step" } & Step)
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
    // 실패한 답변은 빈 문자열이거나 중간에 끊긴 내용이라 대화 기록에서 뺀다 (빈 content는 400)
    body: JSON.stringify({
      messages: history.filter((m) => !m.error).map(({ role, content }) => ({ role, content })),
    }),
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

function describeStep(step: Step) {
  switch (step.node) {
    case "classify":
      return step.needsSearch ? `질문 분석 · 검색어 “${step.searchQuery}”` : "질문 분석 · 문서 검색 없이 답변";
    case "retrieve":
      return `문서 검색 · 관련 청크 ${step.count}개`;
    case "grade":
      return step.isSufficient ? "검색 결과 평가 · 답변하기에 충분" : "검색 결과 평가 · 부족함";
    case "rewrite":
      return `검색어 재작성 · “${step.searchQuery}”`;
  }
}

// 마지막으로 끝난 노드를 보고 지금 진행 중인 일을 보여준다
function describePending(last: Step | undefined) {
  if (!last) return "질문을 분석하고 있어요";
  if (last.node === "classify") return last.needsSearch ? "문서를 찾고 있어요" : "답변을 쓰고 있어요";
  if (last.node === "retrieve") return "검색 결과를 평가하고 있어요";
  if (last.node === "rewrite") return "다시 검색하고 있어요";
  // 부족해도 재검색 한도를 다 썼으면 바로 답변하므로 어느 쪽인지 단정하지 않는다
  return last.isSufficient ? "답변을 쓰고 있어요" : "다음 단계를 진행하고 있어요";
}

// 답변이 나오기 전에는 단계를 펼쳐 보여주고, 답변이 시작되면 접어서 요약만 남긴다
function StepTrace({ steps, live }: { steps: Step[]; live: boolean }) {
  if (!live && steps.length === 0) return null;
  const list = (
    <ol className="space-y-1.5 border-l border-line pl-3">
      {steps.map((step, i) => (
        <li key={i}>{describeStep(step)}</li>
      ))}
      {live && (
        <li className="flex items-center gap-2 text-foreground">
          <span className="size-2 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden />
          {describePending(steps[steps.length - 1])}
        </li>
      )}
    </ol>
  );
  if (live)
    return (
      <div className="text-sm text-muted" aria-live="polite">
        {list}
      </div>
    );

  const searches = steps.filter((step) => step.node === "retrieve").length;
  return (
    <details className="group text-sm text-muted">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
          className="size-4 transition-transform group-open:rotate-90"
        >
          <path
            fillRule="evenodd"
            d="M7.2 14.8a.75.75 0 0 1 0-1.06L10.94 10 7.2 6.26a.75.75 0 1 1 1.06-1.06l4.27 4.27a.75.75 0 0 1 0 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0Z"
            clipRule="evenodd"
          />
        </svg>
        처리 과정 · {searches > 0 ? `검색 ${searches}회` : "검색 없음"}
      </summary>
      <div className="mt-2">{list}</div>
    </details>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
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
        {onRetry && (
          <button
            onClick={onRetry}
            className="!mt-2.5 rounded-md border border-danger-line px-3 py-1 text-sm font-semibold hover:bg-danger-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-danger-text"
          >
            다시 시도
          </button>
        )}
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
    setInput("");
    await ask([...messages, { role: "user", content: question }]);
  }

  // 실패한 마지막 답변을 지우고 같은 질문으로 다시 요청
  function retry() {
    if (isLoading) return;
    ask(messages.slice(0, -1));
  }

  // history는 user 메시지로 끝난다. 그 뒤에 빈 assistant 메시지를 붙여 스트리밍으로 채운다
  async function ask(history: Message[]) {
    setMessages([...history, { role: "assistant", content: "" }]);
    setIsLoading(true);
    // 답변도 에러도 없이 스트림이 끝나면(서버 강제 종료 등) 실패로 표시해 재시도할 수 있게 한다
    let finished = false;
    try {
      await streamChat(history, (event) => {
        if (event.type === "token" || event.type === "error") finished = true;
        if (event.type === "step") updateLast((m) => ({ ...m, steps: [...(m.steps ?? []), event] }));
        else if (event.type === "token") updateLast((m) => ({ ...m, content: m.content + event.text }));
        else if (event.type === "sources") updateLast((m) => ({ ...m, sources: event.sources }));
        else updateLast((m) => ({ ...m, error: event.message }));
      });
      if (!finished) updateLast((m) => ({ ...m, error: "답변을 받기 전에 연결이 끊겼습니다. 다시 시도하세요." }));
    } catch {
      updateLast((m) => ({ ...m, error: "서버에 연결하지 못했습니다. 네트워크 연결을 확인하고 다시 시도하세요." }));
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
              <StepTrace
                steps={message.steps ?? []}
                live={isLoading && i === messages.length - 1 && !message.content && !message.error}
              />
              {message.content && <AnswerMarkdown content={message.content} sources={message.sources} />}
              {message.error && (
                <ErrorNotice
                  message={message.error}
                  // 앞선 답변을 다시 받으면 그 뒤 대화와 어긋나므로 마지막 답변만 재시도할 수 있다
                  onRetry={i === messages.length - 1 && !isLoading ? retry : undefined}
                />
              )}
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
