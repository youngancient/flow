# Flow

An AI content research and publishing agent for a marketing agency's content team. A raw idea or up to three source URLs go in; researched, drafted, evaluated, human-reviewed, channel-adapted content (LinkedIn, X, newsletter) comes out, ready to publish or schedule.

This is an internal team tool, not a public product — login-only, no public sign-up.

## How it works

1. **Research** — scrapes the given source URL(s), or falls back to a web search on the raw idea if none are given (or every scrape fails).
2. **Source selection & grounding** — chunks and embeds every fetched source, then keeps only the chunks that clear a semantic-relevance threshold against the idea and target audience. If nothing clears it, the request is flagged as low-grounding rather than left to hallucinate confidently.
3. **Plan + draft** — drafts three distinct article options (different angles, not near-duplicates), citing only the source excerpts it was actually given.
4. **Evaluate + auto-revise** — each draft is scored against a quality rubric (topic relevance, source grounding, factual consistency, SEO/channel fit, etc.); weak drafts get a bounded number of automatic revision passes before human review.
5. **Human review** — the request's owner can select a draft, edit it directly, or request an AI revision with specific feedback. Everyone on the team can view any request; only the owner can act on it.
6. **Channel adaptation** — the selected draft is reformatted for LinkedIn, X (hard 280-character limit enforced), and email newsletter.
7. **Publish or schedule** — newsletter sends go out for real via Brevo (send now or schedule for later); LinkedIn/X publishing is a label-only queue (mark posted / schedule) — there's no OAuth posting integration.

## Tech stack

- **Next.js** (App Router) + TypeScript
- **Supabase** — Postgres + pgvector for retrieval/persistence, Auth for login
- **Claude API** (Anthropic) — Sonnet for drafting/revision, Haiku for evaluation and channel formatting
- **Firecrawl** — web search and page scraping
- **Voyage AI** — embeddings (`voyage-3.5-lite`)
- **Brevo** — transactional notification email and newsletter campaign sending
- **Discord** (bot API) — pipeline failure alerts to a team channel

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the values — the comments in that file say where to get each key and note any one-time dashboard setup required (Brevo sender/list, Discord bot invite).
3. Run the SQL migrations in `supabase/migrations/` against your Supabase project, in order.
4. Provision at least one login account directly in the Supabase Auth dashboard (Authentication > Users). There's no public sign-up page — accounts are handed out by an admin.
5. `npm run dev` and open [http://localhost:3000](http://localhost:3000).

## Notes

- **Auth**: every page and Server Action/Route Handler requires a real session; the curl-testable API routes under `app/api/requests` also accept a `TESTING_API_TOKEN` bearer token as an alternative to a session cookie.
- **Ownership**: every request has a single owner (whoever submitted it). Only the owner can act on it (select a draft, approve/reject, schedule, publish); everyone else has full read access but no controls.
- **Cost visibility**: every LLM call's token usage and estimated cost is logged per pipeline stage and rolled up into a "Total spend" figure on the dashboard.
- **Scheduled sends**: `POST /api/publish/run-due` is an optional sweep endpoint meant to be hit by an external scheduler (e.g. Vercel Cron); it's protected by `CRON_SECRET` and does nothing if that's unset.
- **No automated test suite** — this has been validated through manual, scenario-based QA against the running app rather than a CI test suite.
