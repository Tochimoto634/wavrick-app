-- 料金（USD）・見積内訳・リテイク決済

alter table public.voice_profiles_public
  add column if not exists price_per_minute numeric,
  add column if not exists minimum_order_price numeric default 0,
  add column if not exists additional_retake_price numeric default 0;

comment on column public.voice_profiles_public.price_per_minute is 'USD per 60s of billed time; min 15';
comment on column public.voice_profiles_public.minimum_order_price is 'USD minimum order floor';
comment on column public.voice_profiles_public.additional_retake_price is 'USD per paid retake session (4th+)';

alter table public.request_workflows_public
  add column if not exists billable_seconds integer default 0,
  add column if not exists quote_amount_usd numeric,
  add column if not exists quote_breakdown jsonb default '{}'::jsonb,
  add column if not exists free_retakes_used integer not null default 0,
  add column if not exists retake_payment_status text default 'none',
  add column if not exists retake_fee_usd numeric default 0;

comment on column public.request_workflows_public.free_retakes_used is 'Count of revision sessions (max 3 free)';
comment on column public.request_workflows_public.retake_payment_status is 'none | required | paid';
