# pgvector-docs-chat 프로젝트 계획

## 개요
PostgreSQL pgvector 공식 문서를 LangGraph 기반 RAG 챗봇으로 검색하는 포트폴리오 프로젝트

## 기술 스택
- Next.js (App Router) — 프론트 + API Routes
- LangGraph + LangChain — AI 워크플로우
- Gemini 2.0 Flash — LLM (무료, 1500 req/day)
- Gemini Embedding API — 텍스트 임베딩
- PostgreSQL + pgvector — 벡터 저장 및 유사도 검색 (Supabase 호스팅)
- Vercel — 배포

## 데이터 소스
- PostgreSQL 공식 문서 pgvector 섹션
- URL: https://www.postgresql.org/docs/current/pgvector.html
- 크롤링 → 청킹 → 임베딩 → pgvector 저장

## LangGraph 워크플로우
1. **의도 분류 노드**: 문서 검색이 필요한 질문인지 판단
2. **RAG 검색 노드**: pgvector 유사도 검색으로 관련 청크 추출
3. **품질 판단 노드**: 검색 결과가 충분한지 평가
4. **재검색 루프**: 불충분하면 쿼리 재작성 후 재검색 (최대 3회)
5. **답변 생성 노드**: 검색 결과 기반 최종 답변 생성

## Phase 1 — 데이터 파이프라인
- [ ] Supabase 프로젝트 생성 및 pgvector 확장 활성화
- [ ] 문서 크롤링 스크립트 작성
- [ ] 청킹 전략 결정 (chunk_size, overlap)
- [ ] Gemini Embedding API로 임베딩 생성
- [ ] pgvector 테이블에 저장

## Phase 2 — LangGraph 워크플로우
- [ ] LangGraph 노드 설계 및 구현
- [ ] 의도 분류 로직
- [ ] RAG 검색 노드
- [ ] 재검색 루프 (Self-RAG 패턴)
- [ ] 답변 생성 노드

## Phase 3 — Next.js 챗봇 UI
- [ ] 채팅 UI 구현
- [ ] 스트리밍 응답 처리
- [ ] 참조 문서 출처 표시
- [ ] Vercel 배포

## DB 스키마
```sql
-- pgvector 확장 활성화
CREATE EXTENSION IF NOT EXISTS vector;

-- 문서 청크 저장
CREATE TABLE doc_chunks (
  id          BIGSERIAL PRIMARY KEY,
  content     TEXT NOT NULL,
  embedding   VECTOR(1536),
  source_url  TEXT,
  chunk_index INT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 벡터 유사도 검색 인덱스 (HNSW)
CREATE INDEX ON doc_chunks
  USING hnsw (embedding vector_cosine_ops);
```

## 폴더 구조
pgvector-docs-chat/
├── apps/
│ └── web/ # Next.js 앱
│ ├── src/
│ │ ├── app/
│ │ │ ├── page.tsx # 챗봇 UI
│ │ │ └── api/
│ │ │ └── chat/
│ │ │ └── route.ts # LangGraph 호출
│ │ └── lib/
│ │ ├── graph/ # LangGraph 노드 정의
│ │ │ ├── index.ts # 그래프 진입점
│ │ │ ├── nodes/
│ │ │ │ ├── classify.ts # 의도 분류
│ │ │ │ ├── retrieve.ts # RAG 검색
│ │ │ │ ├── grade.ts # 품질 판단
│ │ │ │ └── generate.ts # 답변 생성
│ │ │ └── state.ts # 그래프 상태 정의
│ │ └── db/
│ │ └── pgvector.ts # Supabase 연결 + 검색
│ └── package.json
├── scripts/
│ ├── crawl.ts # 문서 크롤링
│ ├── chunk.ts # 청킹
│ └── embed.ts # 임베딩 + DB 저장
├── docs/
│ └── schema.md # DB 스키마 정의서
├── .env.example
├── package.json # pnpm workspace root
├── pnpm-workspace.yaml
├── plan.md
└── README.md

## 참고
- [LangGraph 공식 문서](https://langchain-ai.github.io/langgraphjs/)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [Supabase pgvector 가이드](https://supabase.com/docs/guides/ai/vector-columns)