-- 声優の案件募集ON/OFFステータス
ALTER TABLE voice_profiles_public
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
