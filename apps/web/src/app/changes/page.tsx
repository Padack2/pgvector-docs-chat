import Link from "next/link";
import { type DocChange, loadRecentChanges } from "@/lib/doc-changes";

// 이력은 주 1회 동기화 때 쌓이지만, 요청마다 DB를 읽어 빌드 시점 데이터로 고정되지 않게 한다
export const dynamic = "force-dynamic";

const CHANGE_LABELS: Record<DocChange["change"], string> = { added: "추가", changed: "변경", removed: "삭제" };

const dateOf = (d: Date) =>
  d.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });

// 요약은 API 이름을 `...`로 감싸 쓰므로 그 부분만 코드 글꼴로 보여준다
function SummaryText({ text }: { text: string }) {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="font-mono text-[13px]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

// 동기화 날짜(KST)별로 묶는다. 이력은 최신순으로 온다
function groupByDate(changes: DocChange[]) {
  const groups = new Map<string, DocChange[]>();
  for (const change of changes) {
    const date = dateOf(change.syncedAt);
    groups.set(date, [...(groups.get(date) ?? []), change]);
  }
  return Array.from(groups);
}

export default async function ChangesPage() {
  const changes = await loadRecentChanges();

  return (
    <div className="flex min-h-dvh justify-center">
      <main className="w-full max-w-[44rem] px-4 pb-16 sm:px-6">
        <header className="flex items-baseline justify-between gap-4 border-b border-line py-4">
          <h1 className="text-[17px] font-semibold tracking-tight">최근 문서 변경</h1>
          <Link
            href="/"
            className="text-sm font-semibold text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            대화로 돌아가기
          </Link>
        </header>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          매주 공식 문서를 다시 수집해 바뀐 페이지를 반영하고, 바뀐 내용을 요약합니다.
        </p>

        {changes.length === 0 && <p className="mt-8 text-sm text-muted">아직 기록된 변경이 없습니다.</p>}
        {groupByDate(changes).map(([date, items]) => (
          <section key={date} className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-muted">{date}</h2>
            <ul className="space-y-3">
              {items.map((item) => (
                <li
                  key={item.id}
                  id={`change-${item.id}`}
                  className="scroll-mt-4 rounded-lg border border-line bg-surface px-4 py-3 target:border-accent"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 rounded bg-accent-soft px-1.5 py-px text-[12px] text-accent">
                      {CHANGE_LABELS[item.change]}
                    </span>
                    {item.change === "removed" ? (
                      <span className="font-semibold">{item.title}</span>
                    ) : (
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-semibold underline decoration-line underline-offset-4 hover:text-accent hover:decoration-accent"
                      >
                        {item.title}
                      </a>
                    )}
                  </div>
                  <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed">
                    {item.summary ? <SummaryText text={item.summary} /> : <span className="text-muted">요약은 다음 동기화 때 추가됩니다.</span>}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    </div>
  );
}
