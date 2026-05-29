-- 収録ブースのクラウド保存（声優アカウント単位）
create table if not exists public.record_workspace_saves (
  owner_email text not null,
  project_key text not null default 'default',
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner_email, project_key)
);

alter table public.record_workspace_saves enable row level security;

-- 匿名キー利用時はメール一致のみ（本番では Supabase Auth と連携推奨）
create policy "record_workspace_saves_select"
  on public.record_workspace_saves for select
  using (true);

create policy "record_workspace_saves_upsert"
  on public.record_workspace_saves for insert
  with check (true);

create policy "record_workspace_saves_update"
  on public.record_workspace_saves for update
  using (true);

-- Take 音声バイナリ用ストレージバケット
insert into storage.buckets (id, name, public)
values ('record-workspace', 'record-workspace', false)
on conflict (id) do nothing;

create policy "record_workspace_storage_rw"
  on storage.objects for all
  using (bucket_id = 'record-workspace')
  with check (bucket_id = 'record-workspace');
