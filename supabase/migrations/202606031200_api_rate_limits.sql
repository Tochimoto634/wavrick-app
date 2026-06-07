-- SEC-5: Edge Function 用レート制限バケット（service_role のみ利用）
create table if not exists public.api_rate_limit_buckets (
  bucket_key text primary key,
  hit_count int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.api_rate_limit_buckets enable row level security;

create or replace function public.wavrick_rate_limit_check(
  p_bucket text,
  p_max int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if p_max is null or p_max < 1 then
    return true;
  end if;

  insert into public.api_rate_limit_buckets (bucket_key, hit_count, updated_at)
  values (p_bucket, 1, now())
  on conflict (bucket_key) do update
    set hit_count = public.api_rate_limit_buckets.hit_count + 1,
        updated_at = now()
  returning hit_count into v_count;

  return v_count <= p_max;
end;
$$;

revoke all on function public.wavrick_rate_limit_check(text, int) from public;
grant execute on function public.wavrick_rate_limit_check(text, int) to service_role;
