-- AI Content Research & Publishing Agent — initial schema
-- See artifact/design.md for the full rationale behind every table and column.

create extension if not exists pgcrypto;
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- content_requests: one row per submission; also carries pipeline status.
-- ---------------------------------------------------------------------------
create table content_requests (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  requested_by      text not null,
  submission_key    text not null unique,
  raw_idea          text not null check (char_length(raw_idea) <= 500),
  target_audience   text not null check (char_length(target_audience) <= 300),
  source_url        text,
  supporting_notes  text check (supporting_notes is null or char_length(supporting_notes) <= 5000),
  stage             text not null default 'queued'
                       check (stage in (
                         'queued', 'researching', 'planning_drafting',
                         'evaluating', 'revising', 'ready_for_review', 'failed'
                       )),
  plan              jsonb,
  selected_draft_id uuid,
  low_grounding     boolean not null default false,
  pipeline_log      jsonb not null default '[]'::jsonb,
  pipeline_error    text
);

create index content_requests_stage_idx on content_requests (stage);
create index content_requests_created_at_idx on content_requests (created_at desc);

-- ---------------------------------------------------------------------------
-- sources: one row per retrieval attempt (search result or scrape target).
-- ---------------------------------------------------------------------------
create table sources (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references content_requests(id) on delete cascade,
  source_type   text not null check (source_type in ('search_result', 'scraped_url')),
  url           text,
  title         text,
  query_used    text,
  status        text not null check (status in ('ok', 'failed')),
  error_message text,
  raw_markdown  text,
  fetched_at    timestamptz not null default now()
);

create index sources_request_id_idx on sources (request_id);

-- ---------------------------------------------------------------------------
-- source_chunks: embeddable excerpts — what pgvector actually searches.
-- ---------------------------------------------------------------------------
create table source_chunks (
  id                 uuid primary key default gen_random_uuid(),
  source_id          uuid not null references sources(id) on delete cascade,
  request_id         uuid not null references content_requests(id) on delete cascade,
  chunk_index        int not null,
  chunk_text         text not null,
  embedding          vector(1024),
  relevance_selected boolean not null default false
);

create index source_chunks_request_id_idx on source_chunks (request_id);
create index source_chunks_embedding_idx on source_chunks
  using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- drafts: every article option AND every revision; append-only.
-- ---------------------------------------------------------------------------
create table drafts (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references content_requests(id) on delete cascade,
  option_label       text not null check (option_label in ('A', 'B', 'C')),
  version            int not null,
  parent_draft_id    uuid references drafts(id),
  title              text not null,
  body_markdown      text not null,
  primary_keyword    text,
  secondary_keywords text[] not null default '{}',
  source_chunk_ids   uuid[] not null default '{}',
  revision_source    text not null default 'initial'
                        check (revision_source in (
                          'initial', 'auto_revision', 'human_edit', 'human_requested_ai'
                        )),
  revised_by         text,
  revision_feedback  text,
  created_at         timestamptz not null default now(),
  unique (request_id, option_label, version)
);

create index drafts_request_id_idx on drafts (request_id);
create index drafts_parent_draft_id_idx on drafts (parent_draft_id);

alter table content_requests
  add constraint content_requests_selected_draft_id_fkey
  foreign key (selected_draft_id) references drafts(id);

-- ---------------------------------------------------------------------------
-- evaluations: one row per rubric run of a specific draft version.
-- ---------------------------------------------------------------------------
create table evaluations (
  id                        uuid primary key default gen_random_uuid(),
  draft_id                  uuid not null references drafts(id) on delete cascade,
  overall_status            text not null check (overall_status in ('pass', 'revise', 'reject')),
  criteria                  jsonb not null,
  combined_score            numeric(3, 2),
  unsupported_claims        jsonb not null default '[]'::jsonb,
  sections_needing_revision jsonb not null default '[]'::jsonb,
  recommended_changes       text,
  raw_response               jsonb,
  created_at                timestamptz not null default now()
);

create index evaluations_draft_id_idx on evaluations (draft_id);

-- ---------------------------------------------------------------------------
-- channel_outputs: LinkedIn/X/newsletter adaptation of the selected draft;
-- doubles as the publishing queue. One row per (request, channel) — a
-- regenerate replaces the row in place rather than versioning it, since only
-- the article draft's review history is a hard requirement.
-- ---------------------------------------------------------------------------
create table channel_outputs (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references content_requests(id) on delete cascade,
  draft_id       uuid not null references drafts(id),
  channel        text not null check (channel in ('linkedin', 'x', 'newsletter')),
  subject        text,
  body           text not null,
  hashtags       text[] not null default '{}',
  review_status  text not null default 'pending_review'
                    check (review_status in ('pending_review', 'approved', 'rejected')),
  reviewed_by    text,
  reviewed_at    timestamptz,
  publish_status text not null default 'not_queued'
                    check (publish_status in (
                      'not_queued', 'queued', 'scheduled', 'sending', 'sent', 'failed'
                    )),
  scheduled_for  timestamptz,
  sent_at        timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (request_id, channel)
);

create index channel_outputs_request_id_idx on channel_outputs (request_id);
create index channel_outputs_publish_status_idx on channel_outputs (publish_status);

-- ---------------------------------------------------------------------------
-- RLS: default-deny on every table. All application access goes through the
-- service-role key (lib/supabase/service.ts), which bypasses RLS entirely —
-- that is the real security boundary, not per-row policies (single-role app).
-- ---------------------------------------------------------------------------
alter table content_requests enable row level security;
alter table sources enable row level security;
alter table source_chunks enable row level security;
alter table drafts enable row level security;
alter table evaluations enable row level security;
alter table channel_outputs enable row level security;

-- ---------------------------------------------------------------------------
-- match_source_chunks: server-side similarity search RPC used by Stage 2
-- (source selection). Returns the top `match_count` chunks for a request,
-- ordered by similarity; the MIN_SIMILARITY threshold is applied in code
-- (lib/pipeline.ts, runSourceSelection) so it stays a single tunable
-- constant, not duplicated in SQL.
-- ---------------------------------------------------------------------------
create or replace function match_source_chunks(
  query_embedding vector(1024),
  match_request_id uuid,
  match_count int default 12
)
returns table (
  id uuid,
  source_id uuid,
  chunk_text text,
  similarity float
)
language sql stable
as $$
  select
    source_chunks.id,
    source_chunks.source_id,
    source_chunks.chunk_text,
    1 - (source_chunks.embedding <=> query_embedding) as similarity
  from source_chunks
  where source_chunks.request_id = match_request_id
    and source_chunks.embedding is not null
  order by source_chunks.embedding <=> query_embedding
  limit match_count;
$$;
