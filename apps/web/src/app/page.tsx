"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnswerMarkdown, type Source } from "@/components/AnswerMarkdown";
import type { ClarifyRequest } from "@/lib/graph/nodes/clarify";
import type { ThreadView } from "@/lib/threads";

// 그래프 노드가 끝날 때마다 오는 진행 상황 (route.ts 주석 참고)
type Step =
  | { node: "classify"; needsSearch: boolean; searchQuery: string; needsClarify?: boolean }
  | { node: "clarify"; choice: string | null }
  | { node: "retrieve"; count: number }
  | { node: "grade"; isSufficient: boolean }
  | { node: "rewrite"; searchQuery: string };

type Message = {
  role: "user" | "assistant";
  content: string;
  steps?: Step[];
  sources?: Source[];
  error?: string;
  // 되물음으로 그래프가 멈춰 있으면 그 질문과 선택지 (assistant만)
  clarify?: ClarifyRequest;
  // 질문(user)만: 수정·재시도 때 fork할 체크포인트와 같은 위치의 분기들 (lib/threads.ts)
  forkFrom?: string;
  branches?: string[];
  branchIndex?: number;
};

// /api/chat 요청: 새 질문(message) 또는 되물음에 대한 선택(resume)만 보내고, 대화 기록은 서버의 체크포인트(threadId)에 있다
type ChatRequest = { threadId: string; message?: string; resume?: string; checkpointId?: string };

// /api/chat의 NDJSON 이벤트 (route.ts 주석 참고)
type ChatEvent =
  | ({ type: "step" } & Step)
  | ({ type: "interrupt" } & ClarifyRequest)
  | { type: "token"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "error"; message: string };

const EXAMPLES = [
  "createAgent에 툴은 어떻게 넣어?",
  "LangGraph에서 대화 기록을 유지하려면?",
  "Deep Agents는 일반 에이전트와 뭐가 달라?",
];

async function streamChat(request: ChatRequest, onEvent: (event: ChatEvent) => void) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
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

async function fetchThread(threadId: string, checkpointId?: string): Promise<ThreadView | null> {
  const query = checkpointId ? `?checkpoint=${encodeURIComponent(checkpointId)}` : "";
  const res = await fetch(`/api/threads/${threadId}${query}`);
  return res.ok ? res.json() : null;
}

// 서버에 저장된 대화를 화면 메시지로. 마지막 질문에 답이 없으면 되물음으로 멈춰 있거나 실행이 실패한 것이다
function toMessages(view: ThreadView, run?: Pick<Message, "steps" | "error">): Message[] {
  const messages: Message[] = view.messages.map((m) => ({ ...m }));
  if (messages.at(-1)?.role === "user") {
    messages.push(
      view.interrupt
        ? { role: "assistant", content: "", clarify: view.interrupt, steps: run?.steps }
        : { role: "assistant", content: "", error: "답변을 받지 못한 질문입니다. 다시 시도하세요.", ...run },
    );
  }
  return messages;
}

function threadIdFromUrl() {
  const id = new URLSearchParams(window.location.search).get("thread");
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
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
      if (!step.needsSearch) return "질문 분석 · 문서 검색 없이 답변";
      return step.needsClarify ? "질문 분석 · 프레임워크 확인 필요" : `질문 분석 · 검색어 “${step.searchQuery}”`;
    case "clarify":
      return step.choice ? `되물음 · ${step.choice} 문서에서 검색` : "되물음 · 전체 문서에서 검색";
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
  if (last.node === "classify") {
    if (!last.needsSearch) return "답변을 쓰고 있어요";
    return last.needsClarify ? "어느 프레임워크인지 확인하고 있어요" : "문서를 찾고 있어요";
  }
  if (last.node === "clarify") return "문서를 찾고 있어요";
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
  // 되물음에 아직 답하지 않아 검색 전에 멈춘 상태
  const awaitingChoice =
    steps.some((step) => step.node === "classify" && step.needsClarify) && !steps.some((step) => step.node === "clarify");
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
        처리 과정 · {searches > 0 ? `검색 ${searches}회` : awaitingChoice ? "프레임워크 선택 대기" : "검색 없음"}
      </summary>
      <div className="mt-2">{list}</div>
    </details>
  );
}

// 질문이 여러 프레임워크에 해당될 때 그래프가 멈추고 보여주는 선택지. onSelect가 없으면(진행 중 등) 고를 수 없다
function ClarifyPrompt({ request, onSelect }: { request: ClarifyRequest; onSelect?: (value: string) => void }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="font-semibold">{request.question}</p>
      <p className="mt-0.5 text-sm text-muted">같은 주제가 프레임워크마다 따로 문서화돼 있어요. 고르면 그 문서에서만 찾습니다.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {request.options.map((option) => (
          <button
            key={option.value}
            onClick={() => onSelect?.(option.value)}
            disabled={!onSelect}
            className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent hover:text-accent disabled:opacity-35 disabled:hover:border-line disabled:hover:text-inherit focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
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
  const [threadId, setThreadId] = useState<string | null>(null);
  // 화면에 보이는 분기의 마지막 체크포인트. 다음 질문은 여기서 이어간다
  const [checkpointId, setCheckpointId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastRequest = useRef<ChatRequest | null>(null);
  // 분기를 바꿀 때는 방금 누른 전환 버튼이 화면에 남도록 맨 아래로 스크롤하지 않는다
  const keepScroll = useRef(false);

  useEffect(() => {
    if (keepScroll.current) {
      keepScroll.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // URL의 ?thread=로 저장된 대화를 불러온다 (새로고침·링크 공유)
  useEffect(() => {
    const id = threadIdFromUrl();
    if (!id) return;
    setIsLoading(true);
    fetchThread(id)
      .then((view) => {
        // 없는 대화면 새 대화로 시작
        if (!view) return window.history.replaceState(null, "", window.location.pathname);
        setThreadId(id);
        setMessages(toMessages(view));
        setCheckpointId(view.checkpointId);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  function showView(view: ThreadView, failedRun?: Pick<Message, "steps" | "error">) {
    setMessages(toMessages(view, failedRun));
    setCheckpointId(view.checkpointId);
  }

  function startNewChat() {
    window.history.replaceState(null, "", window.location.pathname);
    setThreadId(null);
    setCheckpointId(null);
    setMessages([]);
    setEditing(null);
  }

  // 스트리밍 중인 마지막 assistant 메시지만 갱신
  const updateLast = (update: (message: Message) => Message) =>
    setMessages((prev) => [...prev.slice(0, -1), update(prev[prev.length - 1])]);

  async function send(question: string) {
    if (!question || isLoading) return;
    setInput("");
    let id = threadId;
    if (!id) {
      id = crypto.randomUUID();
      setThreadId(id);
      window.history.replaceState(null, "", `?thread=${id}`);
    }
    // 마지막 질문이 실패했거나 되물음에 답하지 않은 채 새 질문을 보내면, 그 질문을 대신하도록 그 직전에서 이어간다
    const last = messages.at(-1);
    const replaced = last?.error || last?.clarify ? messages.at(-2) : undefined;
    const base = replaced ? messages.slice(0, -2) : messages;
    await ask(
      { threadId: id, message: question, checkpointId: replaced?.forkFrom ?? checkpointId ?? undefined },
      [...base, { role: "user", content: question }],
    );
  }

  // 실패한 마지막 질문을 그 질문 직전 체크포인트에서 다시 실행 (실패한 실행은 분기 목록에서 숨겨진다)
  function retry() {
    const question = messages.at(-2);
    if (isLoading || !threadId || !question) return;
    // forkFrom이 없으면 서버가 질문을 저장하기 전에 실패한 것이라 같은 요청을 다시 보낸다.
    // 되물음 재개가 실패했어도 질문부터 다시 실행한다 (다시 되묻는다)
    const checkpoint = question.forkFrom ?? lastRequest.current?.checkpointId;
    ask({ threadId, message: question.content, checkpointId: checkpoint }, messages.slice(0, -1));
  }

  // 되물음에 대한 선택으로 멈춘 그래프를 재개한다. 처리 과정은 멈추기 전 단계에 이어 붙인다
  function resumeWith(value: string) {
    const paused = messages.at(-1);
    if (isLoading || !threadId || !paused?.clarify) return;
    ask({ threadId, resume: value, checkpointId: checkpointId ?? undefined }, messages.slice(0, -1), paused.steps);
  }

  // 질문을 고치면 그 질문 직전 체크포인트에서 새 분기로 실행한다
  function submitEdit() {
    if (!editing || !threadId) return;
    const question = messages[editing.index];
    const text = editing.text.trim();
    setEditing(null);
    if (!text || text === question.content || !question.forkFrom) return;
    ask(
      { threadId, message: text, checkpointId: question.forkFrom },
      [...messages.slice(0, editing.index), { role: "user", content: text }],
    );
  }

  async function switchBranch(question: Message, branchIndex: number) {
    const target = question.branches?.[branchIndex];
    if (isLoading || !threadId || !target) return;
    setIsLoading(true);
    const view = await fetchThread(threadId, target).catch(() => null);
    if (view) {
      keepScroll.current = true;
      showView(view);
    }
    setIsLoading(false);
  }

  // shown은 user 메시지로 끝난다. 그 뒤에 빈 assistant 메시지를 붙여 스트리밍으로 채우고,
  // 끝나면 서버에 저장된 대화를 다시 불러와 분기 정보(forkFrom 등)를 받는다
  async function ask(request: ChatRequest, shown: Message[], previousSteps: Step[] = []) {
    lastRequest.current = request;
    setMessages([...shown, { role: "assistant", content: "", steps: previousSteps }]);
    setIsLoading(true);
    // 다시 불러온 대화에는 처리 과정이 없으므로 이번 실행의 것을 옮겨 붙인다
    const run: Pick<Message, "steps" | "error"> = { steps: previousSteps };
    // 답변도 에러도 없이 스트림이 끝나면(서버 강제 종료 등) 실패로 표시해 재시도할 수 있게 한다
    let finished = false;
    try {
      await streamChat(request, (event) => {
        if (event.type === "token" || event.type === "error" || event.type === "interrupt") finished = true;
        if (event.type === "step") {
          run.steps = [...run.steps!, event];
          updateLast((m) => ({ ...m, steps: run.steps }));
        } else if (event.type === "interrupt") {
          updateLast((m) => ({ ...m, clarify: { question: event.question, options: event.options } }));
        } else if (event.type === "token") updateLast((m) => ({ ...m, content: m.content + event.text }));
        else if (event.type === "sources") updateLast((m) => ({ ...m, sources: event.sources }));
        else {
          run.error = event.message;
          updateLast((m) => ({ ...m, error: event.message }));
        }
      });
      if (!finished) {
        run.error = "답변을 받기 전에 연결이 끊겼습니다. 다시 시도하세요.";
        updateLast((m) => ({ ...m, error: run.error }));
      }
      // 서버가 질문을 저장하기 전에 실패했으면(요청 검증 실패 등) 다시 불러오면 질문이 사라지므로 화면 상태를 유지한다
      const view = await fetchThread(request.threadId).catch(() => null);
      if (view && view.messages.length >= shown.length) {
        showView(view, run);
        if (!run.error) setMessages((prev) => [...prev.slice(0, -1), { ...prev[prev.length - 1], steps: run.steps }]);
      }
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
        <div className="flex items-baseline gap-4">
          <p className="hidden text-sm text-muted sm:block">JS/TS 공식 문서 기준</p>
          {messages.length > 0 && (
            <button
              onClick={startNewChat}
              disabled={isLoading}
              className="text-sm font-semibold text-accent hover:underline disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              새 대화
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 space-y-8 overflow-y-auto py-8">
        {/* 저장된 대화를 불러오는 동안에는 첫 화면을 띄우지 않는다 */}
        {messages.length === 0 && !isLoading && (
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
            <div key={i} className="flex flex-col items-end gap-1">
              {editing?.index === i ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitEdit();
                  }}
                  className="w-full max-w-[85%] space-y-2"
                >
                  <label htmlFor={`edit-${i}`} className="sr-only">
                    질문 수정
                  </label>
                  <textarea
                    id={`edit-${i}`}
                    value={editing.text}
                    onChange={(e) => setEditing({ index: i, text: e.target.value })}
                    rows={3}
                    autoFocus
                    className="w-full resize-y rounded-xl border border-accent bg-surface px-4 py-2.5 leading-relaxed outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      취소
                    </button>
                    <button
                      type="submit"
                      disabled={!editing.text.trim()}
                      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-surface disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      다시 묻기
                    </button>
                  </div>
                </form>
              ) : (
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 leading-relaxed">
                  {message.content}
                </p>
              )}
              {/* 서버에 저장된 질문만 수정·분기 전환 가능 (forkFrom은 대화를 다시 불러올 때 받는다) */}
              {editing?.index !== i && message.forkFrom && (
                <div className="flex items-center gap-0.5 text-sm text-muted">
                  {message.branches && message.branches.length > 1 && (
                    <>
                      <button
                        onClick={() => switchBranch(message, message.branchIndex! - 1)}
                        disabled={isLoading || message.branchIndex === 0}
                        aria-label="이전 분기"
                        className="rounded px-1.5 py-0.5 hover:text-foreground disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        ‹
                      </button>
                      <span className="tabular-nums">
                        {message.branchIndex! + 1}/{message.branches.length}
                      </span>
                      <button
                        onClick={() => switchBranch(message, message.branchIndex! + 1)}
                        disabled={isLoading || message.branchIndex === message.branches.length - 1}
                        aria-label="다음 분기"
                        className="rounded px-1.5 py-0.5 hover:text-foreground disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        ›
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => setEditing({ index: i, text: message.content })}
                    disabled={isLoading}
                    className="ml-1 rounded px-1.5 py-0.5 hover:text-foreground disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    수정
                  </button>
                </div>
              )}
            </div>
          ) : (
            <article key={i} className="space-y-4">
              <StepTrace
                steps={message.steps ?? []}
                live={isLoading && i === messages.length - 1 && !message.content && !message.error && !message.clarify}
              />
              {message.clarify && (
                <ClarifyPrompt
                  request={message.clarify}
                  onSelect={i === messages.length - 1 && !isLoading ? resumeWith : undefined}
                />
              )}
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
