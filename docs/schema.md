# DB Schema

## doc_chunks

문서 청크와 임베딩을 저장하는 테이블.

```sql
CREATE TABLE doc_chunks (
  id          BIGSERIAL PRIMARY KEY,
  content     TEXT NOT NULL,
  embedding   VECTOR(1536),
  source_url  TEXT,
  title       TEXT,
  chunk_index INT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON doc_chunks
  USING hnsw (embedding vector_cosine_ops);
```

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | BIGSERIAL | PK |
| content | TEXT | 청크 본문 (NOT NULL) |
| embedding | VECTOR(1536) | 임베딩 벡터 |
| source_url | TEXT | 원본 문서 URL |
| title | TEXT | 원본 문서 제목 (출처 표시용) |
| chunk_index | INT | 원본 문서 내 청크 순서 |
| created_at | TIMESTAMPTZ | 생성 시각 (기본값 NOW()) |

### 인덱스
- HNSW 인덱스 (`vector_cosine_ops`): 코사인 거리(`<=>`) 기반 유사도 검색용
