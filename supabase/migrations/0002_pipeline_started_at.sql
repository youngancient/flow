-- Tracks when the CURRENT pipeline attempt began, separate from created_at
-- (request submission time — immutable, never touched again). Retrying a
-- failed run resets this so PipelineProgress's live elapsed-time counter
-- anchors to the current attempt instead of showing time since the
-- original submission (which could be arbitrarily long after a retry).
alter table content_requests
  add column pipeline_started_at timestamptz not null default now();
