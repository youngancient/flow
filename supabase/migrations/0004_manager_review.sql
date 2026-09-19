-- Manager-review approval structure: the requester can no longer approve
-- their own content. Channel outputs now start as 'draft' (generated but
-- not yet submitted) and only become reviewable once the requester
-- explicitly sends them for approval. A manager (auth.users.raw_app_meta_data
-- ->> 'role' = 'manager', set manually per account — see lib/supabase/auth.ts)
-- then approves, rejects (with a required note), or requests changes (with a
-- required comment). Both rejection and changes-requested feed back into the
-- same existing regenerate/resubmit loop.
alter table channel_outputs
  drop constraint channel_outputs_review_status_check;

alter table channel_outputs
  add constraint channel_outputs_review_status_check
  check (review_status in ('draft', 'pending_review', 'approved', 'rejected', 'changes_requested'));

alter table channel_outputs
  add column review_comment text;
