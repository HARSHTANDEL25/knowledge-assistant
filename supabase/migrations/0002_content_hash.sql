-- Content-hash based duplicate detection: lets ingest() recognize the same
-- document content arriving under a different filename within the same KB,
-- so it can skip re-embedding instead of creating duplicate chunks.

alter table documents add column content_hash text;
create index documents_kb_hash_idx on documents (kb_id, content_hash);

alter table documents drop constraint if exists documents_status_check;
alter table documents add constraint documents_status_check
  check (status in ('pending','processing','ready','failed','duplicate'));
