# pgvector-docs-chat

LangChain 공식 문서(JS/TS)를 LangGraph + RAG 기반으로 검색하는 챗봇입니다.

## Stack

- **Frontend/Backend**: Next.js (App Router)
- **AI Framework**: LangGraph + LangChain
- **LLM**: Gemini 3.8 Flash (로컬 개발 시 Ollama 전환 가능)
- **Vector DB**: PostgreSQL + pgvector (Neon)
- **Embedding**: Gemini Embedding API (`gemini-embedding-001`, 1536차원)
- **Deploy**: Vercel

## Architecture
사용자 질문
↓
[의도 분류 노드]
↓ ↓
문서 검색 (RAG) 단순 답변
↓
[검색 품질 판단]
↓ 불충분 ↓ 충분
재검색 루프 답변 생성
↓
최종 답변

## Getting Started

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
pnpm dev
```

## Environment Variables

```env
LLM_PROVIDER=          # gemini(기본) | ollama
GEMINI_API_KEY=
EMBED_DATABASE_URL=    # 쓰기 계정 (scripts/)
DATABASE_URL=          # 읽기 전용 계정 (Next.js)
```