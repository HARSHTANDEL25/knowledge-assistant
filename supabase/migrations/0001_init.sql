-- ============================================================================
-- Knowledge Assistant — initial schema
-- pgvector + full-text (hybrid search) + RLS-enforced multi-KB isolation
-- ============================================================================
-- Design doc: ../../../.claude/plans/not-workjing-gleaming-meerkat.md
--
-- Security model (the platform rests on this):
--   * hybrid_search() is SECURITY INVOKER  -> RLS on `chunks` applies under the
--     caller's JWT, for BOTH the vector and the keyword leg.
--   * can_access_kb() is SECURITY DEFINER  -> a parameterized boolean check that
--     reads the lookup tables WITHOUT triggering their RLS (prevents infinite
--     recursion when chunks/documents/knowledge_bases policies all call it).
--   * The chat/retrieval path MUST use the user-JWT client. The service-role key
--     bypasses RLS and is for ingestion ONLY.
-- ============================================================================

create extension if not exists vector;

-- ── Tables ──────────────────────────────────────────────────────────────────

create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  role        text not null default 'employee'
                check (role in ('employee','hr_admin','it_admin','project_admin')),
  created_at  timestamptz not null default now()
);

create table knowledge_bases (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('hr','it','project')),  -- hr/it = open, project = restricted
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

create table project_access (
  user_id     uuid not null references profiles (id) on delete cascade,
  kb_id       uuid not null references knowledge_bases (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, kb_id)
);
-- speeds up the RLS EXISTS subquery (eng-review perf finding)
create index project_access_user_kb_idx on project_access (user_id, kb_id);

create table documents (
  id          uuid primary key default gen_random_uuid(),
  kb_id       uuid not null references knowledge_bases (id) on delete cascade,
  source      text not null,                 -- storage path or Confluence URL
  title       text,
  version     int  not null default 1,
  is_current  boolean not null default true, -- retrieval returns only is_current = true
  status      text not null default 'pending'
                check (status in ('pending','processing','ready','failed')),
  created_at  timestamptz not null default now()
);
create index documents_kb_current_idx on documents (kb_id, is_current);

create table chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents (id) on delete cascade,
  kb_id       uuid not null references knowledge_bases (id) on delete cascade,
  content     text not null,
  embedding   vector(384),                   -- all-MiniLM-L6-v2
  -- generated full-text column for the keyword leg of hybrid search
  fts         tsvector generated always as (to_tsvector('english', content)) stored,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
-- vector ANN index (cosine) + keyword GIN index
create index chunks_embedding_hnsw_idx on chunks using hnsw (embedding vector_cosine_ops);
create index chunks_fts_gin_idx         on chunks using gin (fts);
create index chunks_kb_idx              on chunks (kb_id);
create index chunks_document_idx        on chunks (document_id);

create table conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles (id) on delete cascade,
  kb_id       uuid not null references knowledge_bases (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  content         text not null,
  citations       jsonb not null default '[]'::jsonb,
  feedback        smallint,                  -- -1 / null / +1 (thumbs)
  created_at      timestamptz not null default now()
);

-- ── Access-control helper (SECURITY DEFINER — see header) ─────────────────────

create or replace function can_access_kb(target_kb uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from knowledge_bases kb
    where kb.id = target_kb
      and (
        kb.type in ('hr','it')                                   -- open to all authenticated
        or exists (
          select 1 from project_access pa
          where pa.kb_id = kb.id and pa.user_id = auth.uid()      -- explicit project grant
        )
      )
  );
$$;

-- ── New-user trigger: auth.users -> profiles ─────────────────────────────────

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── Row Level Security ───────────────────────────────────────────────────────

alter table profiles        enable row level security;
alter table knowledge_bases enable row level security;
alter table project_access  enable row level security;
alter table documents       enable row level security;
alter table chunks          enable row level security;
alter table conversations   enable row level security;
alter table messages        enable row level security;

-- profiles: a user sees their own row
create policy "own profile" on profiles
  for select using (id = auth.uid());

-- knowledge_bases: visible if accessible (drives which chatbots show in UI)
create policy "visible kbs" on knowledge_bases
  for select using (can_access_kb(id));

-- project_access: a user sees their own grants
create policy "own grants" on project_access
  for select using (user_id = auth.uid());

-- documents: readable if the KB is accessible
create policy "readable documents" on documents
  for select using (can_access_kb(kb_id));

-- chunks: THE boundary — readable only if the KB is accessible
create policy "read accessible chunks" on chunks
  for select using (can_access_kb(kb_id));

-- conversations / messages: a user owns their own
create policy "own conversations" on conversations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own messages" on messages
  for all using (
    exists (select 1 from conversations c
            where c.id = messages.conversation_id and c.user_id = auth.uid())
  ) with check (
    exists (select 1 from conversations c
            where c.id = messages.conversation_id and c.user_id = auth.uid())
  );

-- ── Hybrid search (SECURITY INVOKER — RLS applies to both legs) ──────────────
-- Vector leg + keyword leg fused with Reciprocal Rank Fusion (RRF).
-- Only chunks of the current document version are searched.

create or replace function hybrid_search(
  query_text         text,
  query_embedding    vector(384),
  filter_kb_id       uuid    default null,
  match_count        int     default 5,
  rrf_k              int     default 50,
  full_text_weight   float   default 1.0,
  semantic_weight    float   default 1.0
)
returns setof chunks
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
with current_chunks as (
  select c.*
  from chunks c
  join documents d on d.id = c.document_id and d.is_current
  where (filter_kb_id is null or c.kb_id = filter_kb_id)
),
full_text as (
  select id,
         row_number() over (
           order by ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) desc
         ) as rank_ix
  from current_chunks
  where query_text is not null
    and fts @@ websearch_to_tsquery('english', query_text)
  limit least(match_count, 30) * 2
),
semantic as (
  select id,
         row_number() over (order by embedding <=> query_embedding) as rank_ix
  from current_chunks
  where query_embedding is not null
  limit least(match_count, 30) * 2
)
select cc.*
from full_text
full outer join semantic on full_text.id = semantic.id
join current_chunks cc on cc.id = coalesce(full_text.id, semantic.id)
order by
  coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
  coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight desc
limit least(match_count, 30);
$$;

-- ── Security assertion: hybrid_search must NOT be SECURITY DEFINER ────────────
-- Applying this migration fails loudly if the function is ever changed to
-- DEFINER (which would bypass RLS and leak restricted chunks). P1 eng-review gate.
do $$
begin
  if (select prosecdef from pg_proc where proname = 'hybrid_search') then
    raise exception 'hybrid_search must be SECURITY INVOKER (prosecdef=false) — RLS would be bypassed';
  end if;
end $$;
