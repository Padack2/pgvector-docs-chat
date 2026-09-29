# pgvector-docs-chat

PostgreSQL 공식 문서(pgvector 섹션)를 LangGraph + RAG 기반으로 검색하는 챗봇입니다.

## Stack

- **Frontend/Backend**: Next.js (App Router)
- **AI Framework**: LangGraph + LangChain
- **LLM**: Gemini 2.0 Flash (무료)
- **Vector DB**: PostgreSQL + pgvector (Supabase)
- **Embedding**: Gemini Embedding API
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
cp .env.example .env.local
pnpm dev
```

## Environment Variables

```env
GEMINI_API_KEY=
DATABASE_URL=
```