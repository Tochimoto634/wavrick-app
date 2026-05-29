-- ============================================================
-- WAVRICK RLS Strict Policies
-- Replaces all "using(true) with check(true)" open policies
-- with role-based access control via Supabase Auth JWT.
-- ============================================================

-- ── Drop ALL existing policies first ─────────────────────
DROP POLICY IF EXISTS wavrick_mvp_voice_profiles ON public.voice_profiles_public;
DROP POLICY IF EXISTS voice_profiles_select ON public.voice_profiles_public;
DROP POLICY IF EXISTS voice_profiles_insert ON public.voice_profiles_public;
DROP POLICY IF EXISTS voice_profiles_update ON public.voice_profiles_public;
DROP POLICY IF EXISTS voice_profiles_delete ON public.voice_profiles_public;

DROP POLICY IF EXISTS wavrick_mvp_voice_accounts ON public.voice_accounts_public;
DROP POLICY IF EXISTS voice_accounts_select ON public.voice_accounts_public;
DROP POLICY IF EXISTS voice_accounts_insert ON public.voice_accounts_public;
DROP POLICY IF EXISTS voice_accounts_update ON public.voice_accounts_public;
DROP POLICY IF EXISTS voice_accounts_delete ON public.voice_accounts_public;

DROP POLICY IF EXISTS wavrick_mvp_customer_accounts ON public.customer_accounts_public;
DROP POLICY IF EXISTS customer_accounts_select ON public.customer_accounts_public;
DROP POLICY IF EXISTS customer_accounts_insert ON public.customer_accounts_public;
DROP POLICY IF EXISTS customer_accounts_update ON public.customer_accounts_public;
DROP POLICY IF EXISTS customer_accounts_delete ON public.customer_accounts_public;

DROP POLICY IF EXISTS wavrick_mvp_youtube_requests ON public.youtube_requests_public;
DROP POLICY IF EXISTS youtube_requests_select ON public.youtube_requests_public;
DROP POLICY IF EXISTS youtube_requests_insert ON public.youtube_requests_public;
DROP POLICY IF EXISTS youtube_requests_update ON public.youtube_requests_public;
DROP POLICY IF EXISTS youtube_requests_delete ON public.youtube_requests_public;

DROP POLICY IF EXISTS wavrick_mvp_request_workflows ON public.request_workflows_public;
DROP POLICY IF EXISTS request_workflows_select ON public.request_workflows_public;
DROP POLICY IF EXISTS request_workflows_insert ON public.request_workflows_public;
DROP POLICY IF EXISTS request_workflows_update ON public.request_workflows_public;
DROP POLICY IF EXISTS request_workflows_delete ON public.request_workflows_public;

DROP POLICY IF EXISTS wavrick_mvp_notifications ON public.notifications_public;
DROP POLICY IF EXISTS notifications_select ON public.notifications_public;
DROP POLICY IF EXISTS notifications_insert ON public.notifications_public;
DROP POLICY IF EXISTS notifications_update ON public.notifications_public;
DROP POLICY IF EXISTS notifications_delete ON public.notifications_public;

DROP POLICY IF EXISTS wavrick_mvp_admin_users ON public.admin_users_public;
DROP POLICY IF EXISTS admin_users_select_own ON public.admin_users_public;

DROP POLICY IF EXISTS "record_workspace_saves_select" ON public.record_workspace_saves;
DROP POLICY IF EXISTS "record_workspace_saves_upsert" ON public.record_workspace_saves;
DROP POLICY IF EXISTS "record_workspace_saves_update" ON public.record_workspace_saves;
DROP POLICY IF EXISTS workspace_saves_select ON public.record_workspace_saves;
DROP POLICY IF EXISTS workspace_saves_insert ON public.record_workspace_saves;
DROP POLICY IF EXISTS workspace_saves_update ON public.record_workspace_saves;
DROP POLICY IF EXISTS workspace_saves_delete ON public.record_workspace_saves;

DROP POLICY IF EXISTS "cue_retake_batches_select" ON public.cue_retake_batches;
DROP POLICY IF EXISTS "cue_retake_batches_upsert" ON public.cue_retake_batches;
DROP POLICY IF EXISTS "cue_retake_batches_update" ON public.cue_retake_batches;
DROP POLICY IF EXISTS cue_retake_select ON public.cue_retake_batches;
DROP POLICY IF EXISTS cue_retake_insert ON public.cue_retake_batches;
DROP POLICY IF EXISTS cue_retake_update ON public.cue_retake_batches;
DROP POLICY IF EXISTS cue_retake_delete ON public.cue_retake_batches;

DROP POLICY IF EXISTS "record_workspace_storage_rw" ON storage.objects;
DROP POLICY IF EXISTS "record_workspace_storage_auth" ON storage.objects;

-- ── Helper functions ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auth_email()
RETURNS text
LANGUAGE sql STABLE
AS $auth_email$
  SELECT lower(auth.jwt() ->> 'email');
$auth_email$;

CREATE OR REPLACE FUNCTION public.is_wavrick_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $is_admin$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users_public
    WHERE lower(email) = public.auth_email()
  );
$is_admin$;


-- ============================================================
-- 1. voice_profiles_public  (声優プロフィール — 公開一覧)
-- ============================================================
-- Read: everyone (public listing).  Write: owner or admin.

CREATE POLICY "voice_profiles_select"
  ON public.voice_profiles_public FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "voice_profiles_insert"
  ON public.voice_profiles_public FOR INSERT
  TO authenticated
  WITH CHECK (lower(email) = public.auth_email());

CREATE POLICY "voice_profiles_update"
  ON public.voice_profiles_public FOR UPDATE
  TO authenticated
  USING (lower(email) = public.auth_email() OR public.is_wavrick_admin());

CREATE POLICY "voice_profiles_delete"
  ON public.voice_profiles_public FOR DELETE
  TO authenticated
  USING (public.is_wavrick_admin());


-- ============================================================
-- 2. voice_accounts_public  (声優アカウント)
-- ============================================================

CREATE POLICY "voice_accounts_select"
  ON public.voice_accounts_public FOR SELECT
  TO authenticated
  USING (lower(email) = public.auth_email() OR public.is_wavrick_admin());

CREATE POLICY "voice_accounts_insert"
  ON public.voice_accounts_public FOR INSERT
  TO authenticated
  WITH CHECK (lower(email) = public.auth_email());

CREATE POLICY "voice_accounts_update"
  ON public.voice_accounts_public FOR UPDATE
  TO authenticated
  USING (lower(email) = public.auth_email() OR public.is_wavrick_admin());

CREATE POLICY "voice_accounts_delete"
  ON public.voice_accounts_public FOR DELETE
  TO authenticated
  USING (public.is_wavrick_admin());


-- ============================================================
-- 3. customer_accounts_public  (顧客アカウント)
-- ============================================================

CREATE POLICY "customer_accounts_select"
  ON public.customer_accounts_public FOR SELECT
  TO authenticated
  USING (lower(email) = public.auth_email() OR public.is_wavrick_admin());

CREATE POLICY "customer_accounts_insert"
  ON public.customer_accounts_public FOR INSERT
  TO authenticated
  WITH CHECK (lower(email) = public.auth_email());

CREATE POLICY "customer_accounts_update"
  ON public.customer_accounts_public FOR UPDATE
  TO authenticated
  USING (lower(email) = public.auth_email() OR public.is_wavrick_admin());

CREATE POLICY "customer_accounts_delete"
  ON public.customer_accounts_public FOR DELETE
  TO authenticated
  USING (public.is_wavrick_admin());


-- ============================================================
-- 4. youtube_requests_public  (依頼)
-- ============================================================
-- Read: authenticated users (customers see own, voice actors see
--   requests where they might be cast — using broad read for MVP
--   because cast assignment is in a separate workflow table).
-- Write: customer creates own, admin can update/delete.

CREATE POLICY "youtube_requests_select"
  ON public.youtube_requests_public FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "youtube_requests_insert"
  ON public.youtube_requests_public FOR INSERT
  TO authenticated
  WITH CHECK (lower(email) = public.auth_email());

CREATE POLICY "youtube_requests_update"
  ON public.youtube_requests_public FOR UPDATE
  TO authenticated
  USING (lower(email) = public.auth_email() OR public.is_wavrick_admin());

CREATE POLICY "youtube_requests_delete"
  ON public.youtube_requests_public FOR DELETE
  TO authenticated
  USING (public.is_wavrick_admin());


-- ============================================================
-- 5. request_workflows_public  (ワークフロー)
-- ============================================================
-- Read: all authenticated (both customer and voice actor need access).
-- Insert/Update: authenticated (workflow progression from both sides).
-- Delete: admin only.

CREATE POLICY "request_workflows_select"
  ON public.request_workflows_public FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "request_workflows_insert"
  ON public.request_workflows_public FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "request_workflows_update"
  ON public.request_workflows_public FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "request_workflows_delete"
  ON public.request_workflows_public FOR DELETE
  TO authenticated
  USING (public.is_wavrick_admin());


-- ============================================================
-- 6. notifications_public  (通知)
-- ============================================================
-- Read/Write: authenticated.  Delete: admin.

CREATE POLICY "notifications_select"
  ON public.notifications_public FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "notifications_insert"
  ON public.notifications_public FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "notifications_update"
  ON public.notifications_public FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "notifications_delete"
  ON public.notifications_public FOR DELETE
  TO authenticated
  USING (public.is_wavrick_admin());


-- ============================================================
-- 7. admin_users_public  (管理者)
-- ============================================================
-- Read: own row only (for login check).
-- Insert/Update/Delete: nobody via client — service_role only.

CREATE POLICY "admin_users_select_own"
  ON public.admin_users_public FOR SELECT
  TO authenticated
  USING (lower(email) = public.auth_email());


-- ============================================================
-- 8. record_workspace_saves  (収録ブース保存)
-- ============================================================
-- Owner-only access via owner_email.

CREATE POLICY "workspace_saves_select"
  ON public.record_workspace_saves FOR SELECT
  TO authenticated
  USING (lower(owner_email) = public.auth_email());

CREATE POLICY "workspace_saves_insert"
  ON public.record_workspace_saves FOR INSERT
  TO authenticated
  WITH CHECK (lower(owner_email) = public.auth_email());

CREATE POLICY "workspace_saves_update"
  ON public.record_workspace_saves FOR UPDATE
  TO authenticated
  USING (lower(owner_email) = public.auth_email());

CREATE POLICY "workspace_saves_delete"
  ON public.record_workspace_saves FOR DELETE
  TO authenticated
  USING (lower(owner_email) = public.auth_email());


-- ============================================================
-- 9. cue_retake_batches  (部分リテイク)
-- ============================================================
-- Read/Write: authenticated.  Delete: admin.

CREATE POLICY "cue_retake_select"
  ON public.cue_retake_batches FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "cue_retake_insert"
  ON public.cue_retake_batches FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "cue_retake_update"
  ON public.cue_retake_batches FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "cue_retake_delete"
  ON public.cue_retake_batches FOR DELETE
  TO authenticated
  USING (public.is_wavrick_admin());


-- ============================================================
-- 10. storage: record-workspace bucket
-- ============================================================
-- Restrict to authenticated users only.

CREATE POLICY "record_workspace_storage_auth"
  ON storage.objects FOR ALL
  TO authenticated
  USING (bucket_id = 'record-workspace')
  WITH CHECK (bucket_id = 'record-workspace');


-- ============================================================
-- 11. Revoke blanket grants to anon
-- ============================================================
-- The original setup granted ALL on ALL tables to anon.
-- Revoke write privileges; anon keeps SELECT on voice_profiles
-- via the RLS policy above.

REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon;

-- anon still needs SELECT for voice_profiles_public (public listing)
GRANT SELECT ON public.voice_profiles_public TO anon;
