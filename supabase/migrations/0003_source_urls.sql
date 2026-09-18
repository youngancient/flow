-- Replaces the single optional source_url with up to MAX_SOURCE_URLS (see
-- lib/rules.ts) user-supplied URLs, validated app-side only (no DB-level
-- length/format check, same as the single-URL column it replaces).
-- Existing single values become a 1-element array; requests with no
-- source_url (search-fallback only) become an empty array — both cases
-- read identically to the old null-vs-value distinction downstream.
alter table content_requests add column source_urls text[] not null default '{}';
update content_requests set source_urls = array[source_url] where source_url is not null;
alter table content_requests drop column source_url;
