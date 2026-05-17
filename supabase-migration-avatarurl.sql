-- 声優プロフィールにアイコン URL（data URL 可）を追加
-- Supabase SQL Editor で実行（未実行でも localStorage では動作します）

alter table public.voice_profiles_public
  add column if not exists avatarUrl text;
