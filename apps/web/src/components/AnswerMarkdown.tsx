import { createElement } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

export type Source = { title: string; url: string };

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

// 본문 텍스트의 [n]을 "#cite-n" 링크 노드로 바꾸는 remark 플러그인.
// 문자열 치환과 달리 code·inlineCode 노드는 건드리지 않아 코드 속 arr[1] 같은 표기는 그대로 남는다
function remarkCitations() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link") return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== "text") {
        walk(child);
        return [child];
      }
      return child
        .value!.split(/\[(\d+)\]/)
        .map((part, i) =>
          i % 2 === 1
            ? { type: "link", url: `#cite-${part}`, children: [{ type: "text", value: part }] }
            : { type: "text", value: part },
        )
        .filter((node) => node.type === "link" || node.value);
    });
  };
  return walk;
}

function Citation({ n, source }: { n: number; source?: Source }) {
  const className =
    "mx-0.5 inline-flex h-5 min-w-5 -translate-y-px items-center justify-center rounded-md px-1 align-middle font-mono text-[11px] font-medium no-underline";
  // 출처가 아직 안 왔거나(스트리밍 중) 범위를 벗어난 번호는 링크 없이 표시
  if (!source) return <span className={`${className} border border-line bg-background text-muted`}>{n}</span>;
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={source.title}
      className={`${className} bg-accent-soft text-accent hover:bg-accent hover:text-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
    >
      {n}
    </a>
  );
}

// react-markdown이 넘기는 node(mdast 노드)는 DOM 속성이 아니므로 빼고, className을 입혀 해당 태그로 렌더링
function styled(tag: string, className: string) {
  return function Styled(props: ExtraProps) {
    const rest: Record<string, unknown> = { ...props };
    delete rest.node;
    return createElement(tag, { className, ...rest });
  };
}

const baseComponents: Components = {
  p: styled("p", "my-3 first:mt-0 last:mb-0"),
  // 답변 안의 제목은 페이지 제목보다 한 단계 낮춰 렌더링
  h1: styled("h3", "mb-2 mt-6 text-xl font-semibold tracking-tight first:mt-0"),
  h2: styled("h3", "mb-2 mt-6 text-lg font-semibold tracking-tight first:mt-0"),
  h3: styled("h4", "mb-2 mt-5 font-semibold first:mt-0"),
  h4: styled("h5", "mb-2 mt-4 font-semibold first:mt-0"),
  ul: styled("ul", "my-3 list-disc space-y-1 pl-6 marker:text-muted"),
  ol: styled("ol", "my-3 list-decimal space-y-1 pl-6 marker:text-muted"),
  strong: styled("strong", "font-semibold"),
  blockquote: styled("blockquote", "my-3 border-l-2 border-line pl-4 text-muted"),
  hr: styled("hr", "my-6 border-line"),
  // 인라인 코드 스타일. 코드 블록 안의 code는 아래 pre에서 덮어쓴다
  code: styled("code", "rounded border border-line bg-surface px-1 py-px font-mono text-[0.86em]"),
  pre: styled(
    "pre",
    "my-4 overflow-x-auto rounded-lg border border-line bg-surface p-4 font-mono text-[13px] leading-relaxed [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[1em]",
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: styled("th", "border border-line bg-surface px-3 py-1.5 text-left font-semibold"),
  td: styled("td", "border border-line px-3 py-1.5 align-top"),
};

export function AnswerMarkdown({ content, sources = [] }: { content: string; sources?: Source[] }) {
  const components: Components = {
    ...baseComponents,
    a: ({ href = "", children }) => {
      const cite = href.match(/^#cite-(\d+)$/);
      if (cite) return <Citation n={Number(cite[1])} source={sources[Number(cite[1]) - 1]} />;
      // 문서 원본의 상대 링크(/oss/...)는 우리 사이트가 아니라 LangChain 문서 사이트 기준
      return (
        <a
          href={href.startsWith("/") ? `https://docs.langchain.com${href}` : href}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline decoration-line underline-offset-4 hover:decoration-accent"
        >
          {children}
        </a>
      );
    },
  };

  return (
    <div className="leading-[1.75]">
      <Markdown remarkPlugins={[remarkGfm, remarkCitations]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
