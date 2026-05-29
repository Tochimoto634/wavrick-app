-- WAVRICK MVP public tables (beginner-friendly starter)
-- Run this in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.voice_profiles_public (
  id uuid primary key default gen_random_uuid(),
  lastName text,
  firstName text,
  displayName text not null,
  email text not null,
  bio text not null,
  genres text,
  rateFrom numeric,
  price_per_minute numeric,
  minimum_order_price numeric default 0,
  additional_retake_price numeric default 0,
  jobCount integer,
  sampleUrl text,
  created_at timestamptz not null default now()
);

create index if not exists idx_voice_profiles_public_email
  on public.voice_profiles_public (lower(email));

create table if not exists public.voice_accounts_public (
  id uuid primary key default gen_random_uuid(),
  role text not null default 'voice',
  email text not null,
  displayName text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_voice_accounts_public_email
  on public.voice_accounts_public (lower(email));

create table if not exists public.customer_accounts_public (
  id uuid primary key default gen_random_uuid(),
  role text not null default 'customer',
  email text not null,
  name text,
  channelUrl text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_customer_accounts_public_email
  on public.customer_accounts_public (lower(email));

create table if not exists public.youtube_requests_public (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  channelUrl text not null,
  videoUrl text not null,
  videoChannelUrl text not null,
  tone text,
  deadline text,
  castMode text,
  selectedTalentId text,
  selectedTalentName text,
  recGenres text,
  recBudgetMax text,
  recJobMin text,
  script text,
  created_at timestamptz not null default now()
);

create index if not exists idx_youtube_requests_public_email
  on public.youtube_requests_public (lower(email));

create table if not exists public.admin_users_public (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  displayName text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_admin_users_public_email
  on public.admin_users_public (lower(email));

-- Admin rows must be inserted manually via Supabase dashboard or CLI.
-- Never commit credentials to source code.

create table if not exists public.request_workflows_public (
  id uuid primary key default gen_random_uuid(),
  requestId text not null,
  status text not null,
  messages jsonb not null default '[]'::jsonb,
  quoteAmount text,
  paymentStatus text,
  stripeUrl text,
  deliveries jsonb not null default '[]'::jsonb,
  revisionCount integer not null default 0,
  billable_seconds integer default 0,
  quote_amount_usd numeric,
  quote_breakdown jsonb default '{}'::jsonb,
  free_retakes_used integer not null default 0,
  retake_payment_status text default 'none',
  retake_fee_usd numeric default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists uq_request_workflows_public_requestid
  on public.request_workflows_public (requestId);

create table if not exists public.notifications_public (
  id text primary key,
  requestId text,
  text text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_public_requestid
  on public.notifications_public (requestId);

-- YouTube OAuth (チャンネル所有の本物確認): リポジトリの supabase/functions をデプロイし、
-- Google Cloud Console の OAuth 2.0 クライアントに次を「承認済みのリダイレクト URI」として追加:
--   https://<project-ref>.supabase.co/functions/v1/youtube-oauth-callback
-- Supabase CLI 例:
--   supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... YOUTUBE_OAUTH_STATE_SECRET=...
-- YOUTUBE_OAUTH_STATE_SECRET はランダムな長い文字列（state の HMAC 用）。

-- メディアパイプライン（音声→Whisper→Grok 台本）ジョブ蓄積用（将来の品質改善・学習データに利用）
create table if not exists public.media_pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  request_id text,
  video_url text,
  audio_url text,
  audio_source text,
  status text not null default 'pending',
  step text,
  error text,
  whisper_transcript text,
  whisper_raw jsonb,
  translation text,
  script text,
  training_bundle jsonb not null default '{}'::jsonb,
  models jsonb not null default '{}'::jsonb,
  duration_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_media_pipeline_jobs_user
  on public.media_pipeline_jobs (user_id);

create index if not exists idx_media_pipeline_jobs_created
  on public.media_pipeline_jobs (created_at desc);

alter table public.media_pipeline_jobs enable row level security;

create policy media_pipeline_jobs_select_own
  on public.media_pipeline_jobs
  for select
  using (auth.uid() = user_id);

-- insert/update は service_role（Edge Function）のみ想定。anon/authenticated からの直接 insert は不可。

-- media-pipeline Edge: secrets に OPENAI_API_KEY, XAI_API_KEY を設定。
-- YouTube からの音声抽出は Deno 単体では困難なため、YOUTUBE_AUDIO_PROXY_URL + YOUTUBE_AUDIO_PROXY_SECRET（任意）で
-- リポジトリの services/youtube-audio-proxy を自前デプロイするか、同等の POST { videoUrl } → audio bytes を返すサービスを接続。
-- 代替: リクエスト body に audioUrl を渡し、Edge がその URL から音声を取得して Whisper に送る（署名付きURL等）。
--
-- media-pipeline Edge Function:
--   supabase secrets set OPENAI_API_KEY=... XAI_API_KEY=...
--   任意: GROK_MODEL=grok-4.3  YOUTUBE_AUDIO_PROXY_URL=https://.../extract  YOUTUBE_AUDIO_PROXY_SECRET=...
--   deploy: supabase functions deploy media-pipeline

-- ── RLS: Role-based access control ──────────────────────────
-- See supabase/migrations/202605260002_rls_strict.sql for the
-- full policy set. Below is the base grant + RLS enablement.

grant usage on schema public to anon, authenticated;
grant select on public.voice_profiles_public to anon;
grant all on all tables in schema public to authenticated;

-- Helper functions for RLS policies
CREATE OR REPLACE FUNCTION public.auth_email()
RETURNS text LANGUAGE sql STABLE
AS $$ SELECT lower(auth.jwt() ->> 'email'); $$;

CREATE OR REPLACE FUNCTION public.is_wavrick_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users_public
    WHERE lower(email) = public.auth_email()
  );
$$;

-- Enable RLS on all tables
alter table public.youtube_requests_public enable row level security;
alter table public.customer_accounts_public enable row level security;
alter table public.voice_profiles_public enable row level security;
alter table public.voice_accounts_public enable row level security;
alter table public.request_workflows_public enable row level security;
alter table public.notifications_public enable row level security;
alter table public.admin_users_public enable row level security;

-- voice_profiles_public: public read, authenticated owner write
create policy voice_profiles_select on public.voice_profiles_public for select to anon, authenticated using (true);
create policy voice_profiles_insert on public.voice_profiles_public for insert to authenticated with check (lower(email) = public.auth_email());
create policy voice_profiles_update on public.voice_profiles_public for update to authenticated using (lower(email) = public.auth_email() or public.is_wavrick_admin());
create policy voice_profiles_delete on public.voice_profiles_public for delete to authenticated using (public.is_wavrick_admin());

-- voice_accounts_public: own row or admin
create policy voice_accounts_select on public.voice_accounts_public for select to authenticated using (lower(email) = public.auth_email() or public.is_wavrick_admin());
create policy voice_accounts_insert on public.voice_accounts_public for insert to authenticated with check (lower(email) = public.auth_email());
create policy voice_accounts_update on public.voice_accounts_public for update to authenticated using (lower(email) = public.auth_email() or public.is_wavrick_admin());
create policy voice_accounts_delete on public.voice_accounts_public for delete to authenticated using (public.is_wavrick_admin());

-- customer_accounts_public: own row or admin
create policy customer_accounts_select on public.customer_accounts_public for select to authenticated using (lower(email) = public.auth_email() or public.is_wavrick_admin());
create policy customer_accounts_insert on public.customer_accounts_public for insert to authenticated with check (lower(email) = public.auth_email());
create policy customer_accounts_update on public.customer_accounts_public for update to authenticated using (lower(email) = public.auth_email() or public.is_wavrick_admin());
create policy customer_accounts_delete on public.customer_accounts_public for delete to authenticated using (public.is_wavrick_admin());

-- youtube_requests_public: authenticated read all, write own or admin
create policy youtube_requests_select on public.youtube_requests_public for select to authenticated using (true);
create policy youtube_requests_insert on public.youtube_requests_public for insert to authenticated with check (lower(email) = public.auth_email());
create policy youtube_requests_update on public.youtube_requests_public for update to authenticated using (lower(email) = public.auth_email() or public.is_wavrick_admin());
create policy youtube_requests_delete on public.youtube_requests_public for delete to authenticated using (public.is_wavrick_admin());

-- request_workflows_public: authenticated, delete admin only
create policy request_workflows_select on public.request_workflows_public for select to authenticated using (true);
create policy request_workflows_insert on public.request_workflows_public for insert to authenticated with check (true);
create policy request_workflows_update on public.request_workflows_public for update to authenticated using (true);
create policy request_workflows_delete on public.request_workflows_public for delete to authenticated using (public.is_wavrick_admin());

-- notifications_public: authenticated, delete admin only
create policy notifications_select on public.notifications_public for select to authenticated using (true);
create policy notifications_insert on public.notifications_public for insert to authenticated with check (true);
create policy notifications_update on public.notifications_public for update to authenticated using (true);
create policy notifications_delete on public.notifications_public for delete to authenticated using (public.is_wavrick_admin());

-- admin_users_public: select own row only (for login verification)
create policy admin_users_select_own on public.admin_users_public for select to authenticated using (lower(email) = public.auth_email());
