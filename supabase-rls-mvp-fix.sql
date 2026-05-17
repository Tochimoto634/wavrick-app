-- WAVRICK MVP: ブラウザ(anon key)から *_public テーブルへ保存できるようにする
-- エラー例: new row violates row-level security policy for table "youtube_requests_public"
-- Supabase SQL Editor でこのファイルを丸ごと Run（ブロック1のあと、またはエラーが出たら）

grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- youtube_requests_public
alter table public.youtube_requests_public enable row level security;
drop policy if exists wavrick_mvp_youtube_requests on public.youtube_requests_public;
create policy wavrick_mvp_youtube_requests
  on public.youtube_requests_public
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- customer_accounts_public
alter table public.customer_accounts_public enable row level security;
drop policy if exists wavrick_mvp_customer_accounts on public.customer_accounts_public;
create policy wavrick_mvp_customer_accounts
  on public.customer_accounts_public
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- voice_profiles_public
alter table public.voice_profiles_public enable row level security;
drop policy if exists wavrick_mvp_voice_profiles on public.voice_profiles_public;
create policy wavrick_mvp_voice_profiles
  on public.voice_profiles_public
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- voice_accounts_public
alter table public.voice_accounts_public enable row level security;
drop policy if exists wavrick_mvp_voice_accounts on public.voice_accounts_public;
create policy wavrick_mvp_voice_accounts
  on public.voice_accounts_public
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- request_workflows_public
alter table public.request_workflows_public enable row level security;
drop policy if exists wavrick_mvp_request_workflows on public.request_workflows_public;
create policy wavrick_mvp_request_workflows
  on public.request_workflows_public
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- notifications_public
alter table public.notifications_public enable row level security;
drop policy if exists wavrick_mvp_notifications on public.notifications_public;
create policy wavrick_mvp_notifications
  on public.notifications_public
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- admin_users_public（運営メール確認用の read）
alter table public.admin_users_public enable row level security;
drop policy if exists wavrick_mvp_admin_users on public.admin_users_public;
create policy wavrick_mvp_admin_users
  on public.admin_users_public
  for all
  to anon, authenticated
  using (true)
  with check (true);
