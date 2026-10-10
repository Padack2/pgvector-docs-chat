// lib/graph/index.ts의 그래프를 그대로 옮겨 그린 그림. 그래프 구조를 바꾸면 여기 좌표·엣지도 같이 고쳐야 한다
export type NodeName = "classify" | "clarify" | "retrieve" | "grade" | "rewrite" | "generate";

const NODES: Record<NodeName, { x: number; y: number; w: number; label: string }> = {
  classify: { x: 150, y: 64, w: 112, label: "질문 분석" },
  clarify: { x: 150, y: 136, w: 112, label: "되물음" },
  retrieve: { x: 150, y: 208, w: 112, label: "문서 검색" },
  grade: { x: 150, y: 280, w: 112, label: "결과 평가" },
  rewrite: { x: 254, y: 244, w: 80, label: "재작성" },
  generate: { x: 150, y: 364, w: 112, label: "답변 생성" },
};
const NODE_H = 40;
const START_Y = 16;
const END_Y = 416;

// from>to 키와 SVG 경로. 조건부 엣지에는 분기 조건을 적는다
const EDGES: { from: string; to: string; d: string; label?: { text: string; x: number; y: number } }[] = [
  { from: "start", to: "classify", d: `M150 ${START_Y + 5} V44` },
  { from: "classify", to: "clarify", d: "M150 84 V116", label: { text: "애매", x: 156, y: 104 } },
  { from: "clarify", to: "retrieve", d: "M150 156 V188" },
  { from: "classify", to: "retrieve", d: "M94 70 H70 V208 H94", label: { text: "검색", x: 74, y: 146 } },
  { from: "classify", to: "generate", d: "M94 58 H34 V364 H94", label: { text: "검색 불필요", x: 38, y: 240 } },
  { from: "retrieve", to: "grade", d: "M150 228 V260" },
  { from: "grade", to: "rewrite", d: "M206 280 H254 V264", label: { text: "부족", x: 216, y: 294 } },
  { from: "rewrite", to: "retrieve", d: "M254 224 V208 H206" },
  { from: "grade", to: "generate", d: "M150 300 V344", label: { text: "충분", x: 156, y: 326 } },
  { from: "generate", to: "end", d: `M150 384 V${END_Y - 5}` },
];

export type GraphRun = {
  // 지나온 노드 순서 (끝난 노드만)
  path: NodeName[];
  // 실행 중이거나, 되물음으로 멈췄거나, 실패한 노드
  current?: { node: NodeName; state: "running" | "waiting" | "failed" };
  done: boolean;
};

export function GraphPanel({ run }: { run?: GraphRun }) {
  const path: string[] = run ? ["start", ...run.path] : [];
  if (run?.current) path.push(run.current.node);
  if (run?.done) path.push("end");
  const visitedEdges = new Set(path.slice(1).map((to, i) => `${path[i]}>${to}`));
  const visitedNodes = new Set(path);
  const searches = path.filter((node) => node === "retrieve").length;

  return (
    <svg viewBox="0 0 300 432" className="w-full" role="img" aria-label="답변 처리 그래프">
      <defs>
        <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="var(--line)" />
        </marker>
        <marker id="arrow-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="var(--accent)" />
        </marker>
      </defs>

      {EDGES.map((edge) => {
        const on = visitedEdges.has(`${edge.from}>${edge.to}`);
        return (
          <g key={`${edge.from}>${edge.to}`}>
            <path
              d={edge.d}
              fill="none"
              stroke={on ? "var(--accent)" : "var(--line)"}
              strokeWidth={on ? 2 : 1.25}
              markerEnd={`url(#${on ? "arrow-on" : "arrow"})`}
            />
            {edge.label && (
              <text x={edge.label.x} y={edge.label.y} fontSize="10" fill={on ? "var(--accent)" : "var(--muted)"}>
                {edge.label.text}
              </text>
            )}
          </g>
        );
      })}

      <circle cx="150" cy={START_Y} r="5" fill={run ? "var(--accent)" : "var(--line)"} />
      <circle cx="150" cy={END_Y} r="5" fill={run?.done ? "var(--accent)" : "var(--line)"} />

      {(Object.keys(NODES) as NodeName[]).map((name) => {
        const { x, y, w, label } = NODES[name];
        const state = run?.current?.node === name ? run.current.state : visitedNodes.has(name) ? "visited" : "idle";
        const fill = {
          idle: "var(--surface)",
          visited: "var(--accent-soft)",
          running: "var(--accent)",
          waiting: "var(--surface)",
          failed: "var(--danger-bg)",
        }[state];
        const stroke = {
          idle: "var(--line)",
          visited: "var(--accent)",
          running: "var(--accent)",
          waiting: "var(--accent)",
          failed: "var(--danger-text)",
        }[state];
        const text = {
          idle: "var(--muted)",
          visited: "var(--foreground)",
          running: "var(--surface)",
          waiting: "var(--accent)",
          failed: "var(--danger-text)",
        }[state];
        return (
          <g key={name} className={state === "running" ? "motion-safe:animate-pulse" : undefined}>
            <rect
              x={x - w / 2}
              y={y - NODE_H / 2}
              width={w}
              height={NODE_H}
              rx="8"
              fill={fill}
              stroke={stroke}
              strokeWidth={state === "idle" ? 1.25 : 2}
              strokeDasharray={state === "waiting" ? "4 3" : undefined}
            />
            <text x={x} y={y - 3} textAnchor="middle" fontSize="12" fontWeight="600" fill={text}>
              {label}
            </text>
            <text
              x={x}
              y={y + 11}
              textAnchor="middle"
              fontSize="9.5"
              fontFamily="var(--font-mono)"
              fill={text}
              opacity="0.8"
            >
              {name}
            </text>
            {name === "retrieve" && searches > 1 && (
              <text
                x={x + w / 2 - 6}
                y={y - NODE_H / 2 - 4}
                textAnchor="end"
                fontSize="10"
                fontWeight="600"
                fill="var(--accent)"
              >
                ×{searches}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
