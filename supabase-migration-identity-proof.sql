-- 依頼に身分証ステップの結果（短文のみ。画像は別途運営保管を推奨）
alter table public.youtube_requests_public
  add column if not exists identityprooftext text;
