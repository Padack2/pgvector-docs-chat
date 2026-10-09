import { NextResponse } from "next/server";
import { z } from "zod";
import { loadThread } from "@/lib/threads";

// 저장된 대화 불러오기. ?checkpoint=<id>면 그 체크포인트로 끝나는 분기를, 없으면 가장 최근 분기를 돌려준다
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const threadId = z.uuid().safeParse(params.id);
  if (!threadId.success) return NextResponse.json({ error: "잘못된 대화 id입니다" }, { status: 400 });

  const checkpointId = new URL(req.url).searchParams.get("checkpoint") ?? undefined;
  const view = await loadThread(threadId.data, checkpointId);
  if (!view) return NextResponse.json({ error: "대화를 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json(view);
}
