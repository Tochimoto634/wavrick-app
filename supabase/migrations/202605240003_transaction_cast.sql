-- 仮決済・声優受諾フロー

alter table public.request_workflows_public
  add column if not exists transaction_phase text default 'draft',
  add column if not exists cast_acceptance jsonb default '[]'::jsonb,
  add column if not exists omakase_criteria jsonb default '{}'::jsonb,
  add column if not exists provisional_paid_at timestamptz,
  add column if not exists stripe_payment_intent_id text;

comment on column public.request_workflows_public.transaction_phase is 'draft|quoted|paid_provisional|awaiting_acceptance|in_production|cancelled';
comment on column public.request_workflows_public.cast_acceptance is 'Per-speaker cast + acceptance status';
