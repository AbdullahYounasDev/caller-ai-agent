# caller-ai-agent

An AI phone agent for small businesses. A business gives the agent its own
material — price list, opening hours, policies — and the agent answers its
customers' questions from it, in the customer's language (English and Urdu).

The calling channel (Twilio) is not built yet. What exists is the engine
underneath it — document ingestion, hybrid retrieval, the shared `respond()`
brain — and an internal test console to exercise it. Every channel will be a thin
adapter over that one brain.

**Read [CLAUDE.md](CLAUDE.md) before changing anything.** It is the handover
document: the design decisions that are settled, the failures behind each rule,
what works and what does not, and the measured retrieval numbers.

## Stack

Next.js 16 (App Router, JavaScript), React 19, Tailwind v4, Postgres 16 with
pgvector, Prisma 6, Gemini (embeddings and chat; chat is pluggable, embeddings are
not), optional Cloudinary for original uploaded files.

## Setup

Needs Node.js, Docker, and a Gemini API key.

```bash
npm install
cp .env.example .env     # set GEMINI_API_KEY; the default DATABASE_URL matches docker-compose.yml
npm run db:up            # Postgres 16 + pgvector
npm run prisma:migrate   # apply migrations
npm run dev              # http://localhost:3000 — the test console
```

`INTERNAL_API_KEY` guards every route. Leave it unset locally (the console cannot
send the header); it fails closed in production. All environment variables are
documented in `.env.example`.

The free Gemini tier is small (about 1000 embedding texts a day, counted per
text) and is easy to exhaust while testing; see CLAUDE.md §8.

## Commands

| | |
| --- | --- |
| `npm run dev` / `build` / `start` | run, build (runs `i18n:check` first), serve |
| `npm run lint` | ESLint |
| `npm run db:up` / `db:down` | start / stop Postgres |
| `npm run prisma:migrate` | apply migrations — read any generated one; Prisma wants to drop the HNSW index |
| `npm run db:check` | verify the HNSW index, pgvector features, language columns, embedding scheme |
| `npm run i18n:check` | translation key and placeholder parity |
| `npm run eval:real` | the retrieval gate: real pipeline, `test-docs/` corpus, compared with a saved baseline |
| `npm run eval:real:sweep` | per-category relevance-threshold boundary |
| `npm run eval:retrieval` / `eval:sweep` | fast fixture-only smoke check |
| `npm run eval:embedding-variants` | compare embedding schemes in memory before re-embedding |
| `npm run reembed:dry` / `reembed` | count / run a resumable re-embed of existing documents |
| `npm run db:backfill-search` | label chunks with their document's language (no embeddings) |
| `npm run test:reembed` | ingest and re-embed invariants with a faked embedder (no quota) |
| `npm run test:openrouter` | OpenRouter integration against a local stand-in |

The evals and `reembed` spend embedding quota; the details, flags and the
recommended order are in CLAUDE.md §10 and §6.20.

## Layout

- `src/lib/agent/` — the engine: `respond.js` (the brain), `retrieve.js`,
  `query.js`, `prompt.js`, `ingest.js`, `chunk.js`, `llm.js` (the model seam).
- `src/app/api/` — chat, knowledge, agent-config and debug routes.
- `src/app/page.js` — the test console.
- `scripts/` — evals, re-embed, checks.
- `test-docs/` — the fixture corpus the evals use.

Full layout: CLAUDE.md §5.
