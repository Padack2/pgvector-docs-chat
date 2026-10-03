// 저장(scripts/embed.ts)과 검색이 반드시 같은 모델·차원을 써야 하므로 이 파일 하나에서 관리한다 (ADR-001)
// 바꾸면 DB 스키마 VECTOR(n) 변경 + 전체 재임베딩 필요
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 1536;

const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`;
// 무료 티어는 분당 토큰 한도(약 2~3만)에 걸린다. 청크 50개 ≈ 1.5만 토큰
export const EMBED_BATCH_SIZE = 50;
const MAX_RETRIES = 5;

type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

// 3072 미만 차원은 정규화되지 않은 벡터가 오므로 코사인 검색 전에 L2 정규화
function normalize(v: number[]): number[] {
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

async function batchEmbed(texts: string[], taskType: TaskType): Promise<number[][]> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
    });
    if (res.ok) {
      const { embeddings } = (await res.json()) as { embeddings: { values: number[] }[] };
      return embeddings.map((e) => normalize(e.values));
    }

    const body = await res.text();
    if ((res.status !== 429 && res.status < 500) || attempt === MAX_RETRIES) {
      throw new Error(`embedding failed (${res.status}): ${body}`);
    }
    // 429는 분당 한도 초과라 retryDelay가 없으면 1분 창이 지나도록 60초 대기
    const retryDelay = body.match(/"retryDelay":\s*"(\d+)/)?.[1];
    const delaySec = retryDelay ? Number(retryDelay) : res.status === 429 ? 60 : 2 ** attempt;
    // 대기 시간이 몇 시간 단위면 일일 한도 소진이므로 기다리지 않고 중단
    if (delaySec > 120) {
      throw new Error(`embedding daily quota exhausted, retry after ~${Math.ceil(delaySec / 3600)}h`);
    }
    console.warn(`embedding ${res.status}, retry in ${delaySec}s (${attempt}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, delaySec * 1000));
  }
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    vectors.push(...(await batchEmbed(texts.slice(i, i + EMBED_BATCH_SIZE), "RETRIEVAL_DOCUMENT")));
  }
  return vectors;
}

export async function embedQuery(text: string): Promise<number[]> {
  return (await batchEmbed([text], "RETRIEVAL_QUERY"))[0];
}
