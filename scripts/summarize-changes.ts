// doc_changes에서 요약이 없는 이력을 요약한다 (embed 다음 단계, Phase 10)
// - removed: LLM 없이 고정 문구
// - added·changed: 바뀐 섹션의 전/후 본문을 주고 페이지당 LLM 1회
// LLM 한도를 챗봇과 나눠 쓰므로 1회 실행에서 상한까지만 요약하고 나머지는 다음 실행으로 넘긴다 (요약이 NULL인 행부터 이어서 처리)
import pg from "pg";
import { invokeChat } from "../apps/web/src/lib/llm";

const MAX_SUMMARIES_PER_RUN = 30;
// 섹션이 많거나 긴 페이지(신규 페이지 등)도 요청 1회에 담기도록 본문을 자른다
const MAX_SECTION_CHARS = 3_000;
const MAX_INPUT_CHARS = 30_000;

type SectionChange = { path: string; change: "added" | "changed" | "removed"; before: string | null; after: string | null };

const DIFF_CONTEXT_CHARS = 300;

// 달라진 구간은 처음과 끝이 모두 변경 지점이므로 가운데를 생략한다
const clip = (text: string) =>
  text.length > MAX_SECTION_CHARS
    ? `${text.slice(0, MAX_SECTION_CHARS / 2)}\n...(중간 생략)\n${text.slice(-MAX_SECTION_CHARS / 2)}`
    : text;

// 긴 섹션(3만 자 이상도 있음)은 앞부분만 자르면 실제로 바뀐 곳이 빠지므로, 전/후 공통 앞뒤를 덜어내고 달라진 구간만 남긴다
function changedRegion(before: string, after: string): [string, string] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const from = Math.max(0, start - DIFF_CONTEXT_CHARS);
  const cut = (text: string) => {
    const to = Math.min(text.length, text.length - end + DIFF_CONTEXT_CHARS);
    return `${from > 0 ? "...(앞 생략)\n" : ""}${text.slice(from, to)}${to < text.length ? "\n...(뒤 생략)" : ""}`;
  };
  return [cut(before), cut(after)];
}

function formatSections(sections: SectionChange[]): string {
  const parts = sections.map(({ path, change, before, after }) => {
    if (before !== null && after !== null) [before, after] = changedRegion(before, after);
    return [
      `### ${path} (${change})`,
      before !== null ? `[변경 전]\n${clip(before)}` : "",
      after !== null ? `[변경 후]\n${clip(after)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  });
  return parts.join("\n\n").slice(0, MAX_INPUT_CHARS);
}

const PROMPT = `당신은 LangChain·LangGraph JavaScript 문서의 변경 내역을 정리하는 기술 문서 편집자입니다.
아래는 한 문서 페이지에서 바뀐 섹션의 변경 전/후 본문입니다.
개발자가 알아야 할 변경 사항을 한국어 1~3문장으로 요약하세요.
- 추가·삭제·이름이 바뀐 API, 옵션, 사용법을 구체적인 이름과 함께 쓰세요
- 오타·링크·서식만 바뀌었으면 "문구·서식 수정"이라고만 쓰세요
- 본문에 없는 내용은 추측하지 마세요`;

const client = new pg.Client({ connectionString: process.env.EMBED_DATABASE_URL });
await client.connect();

const { rows } = await client.query<{ id: string; title: string; change: string; sections: SectionChange[] }>(
  "SELECT id, title, change, sections FROM doc_changes WHERE summary IS NULL ORDER BY id",
);
console.log(`changes without summary: ${rows.length}`);

let summarized = 0;
for (const row of rows) {
  let summary: string;
  if (row.change === "removed") {
    summary = "페이지가 문서에서 삭제되었습니다.";
  } else {
    if (summarized >= MAX_SUMMARIES_PER_RUN) {
      console.log(`  summary limit (${MAX_SUMMARIES_PER_RUN}/run) reached, rest left for next run`);
      break;
    }
    const kind = row.change === "added" ? "새로 추가된 페이지" : "변경된 페이지";
    // scripts 패키지는 @langchain/core에 의존하지 않으므로 메시지를 {role, content}로 넘긴다 (LangChain이 변환)
    const messages = [
      { role: "system", content: PROMPT },
      { role: "user", content: `페이지: ${row.title} (${kind})\n\n${formatSections(row.sections)}` },
    ];
    const response = await invokeChat(messages as unknown as Parameters<typeof invokeChat>[0]);
    summary = response.text.trim();
    summarized++;
  }
  await client.query("UPDATE doc_changes SET summary = $1 WHERE id = $2", [summary, row.id]);
  console.log(`  #${row.id} ${row.title}: ${summary}`);
}

console.log(`done. LLM summaries: ${summarized}`);
await client.end();
