-- 顧客の部分リテイク依頼（目安枠 cueId 単位）
create table if not exists public.cue_retake_batches (
  project_id text not null primary key,
  request_id text,
  delivery_id text,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists cue_retake_batches_request_id_idx
  on public.cue_retake_batches (request_id);

alter table public.cue_retake_batches enable row level security;

create policy "cue_retake_batches_select"
  on public.cue_retake_batches for select using (true);

create policy "cue_retake_batches_upsert"
  on public.cue_retake_batches for insert with check (true);

create policy "cue_retake_batches_update"
  on public.cue_retake_batches for update using (true);
