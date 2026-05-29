/**
 * 収録ブース — アカウント紐づけのクラウド保存（Supabase）
 */

const SAVE_TABLE = "record_workspace_saves";
const STORAGE_BUCKET = "record-workspace";
const PROJECT_KEY = "default";

function readSupabaseConfig() {
  const fromWindow = window.WAVRICK_CONFIG || {};
  if (fromWindow.supabaseUrl && fromWindow.supabaseAnonKey) {
    return {
      supabaseUrl: fromWindow.supabaseUrl,
      supabaseAnonKey: fromWindow.supabaseAnonKey
    };
  }
  try {
    const raw = localStorage.getItem("wavrick_supabase_config");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.supabaseUrl && parsed?.supabaseAnonKey) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

export function isCloudSaveAvailable() {
  const cfg = readSupabaseConfig();
  return Boolean(cfg?.supabaseUrl && cfg?.supabaseAnonKey && globalThis.supabase?.createClient);
}

function getClient() {
  const cfg = readSupabaseConfig();
  if (!cfg || !globalThis.supabase?.createClient) return null;
  return globalThis.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
}

function ownerPath(email) {
  return encodeURIComponent(String(email).toLowerCase().trim());
}

function manifestPath(email) {
  return `${ownerPath(email)}/${PROJECT_KEY}/manifest.json`;
}

function takeStoragePath(email, takeId) {
  return `${ownerPath(email)}/${PROJECT_KEY}/takes/${takeId}.bin`;
}

/**
 * @param {string} email
 * @param {object} manifest
 * @param {Map<string, Blob>} takeBlobs takeId → blob
 */
export async function saveWorkspaceToCloud(email, manifest, takeBlobs) {
  const client = getClient();
  if (!client) {
    throw new Error(
      "Supabase が未設定です。index.html の WAVRICK_CONFIG またはトップの Supabase 設定を確認してください。"
    );
  }

  const manifestJson = JSON.stringify(manifest);
  const manifestBlob = new Blob([manifestJson], { type: "application/json" });

  const uploadTake = async (takeId, blob) => {
    const path = takeStoragePath(email, takeId);
    const { error } = await client.storage.from(STORAGE_BUCKET).upload(path, blob, {
      upsert: true,
      contentType: blob.type || "audio/webm"
    });
    if (error) throw new Error(`Take 音声の保存に失敗 (${takeId}): ${error.message}`);
  };

  for (const [takeId, blob] of takeBlobs) {
    if (blob && blob.size > 0) await uploadTake(takeId, blob);
  }

  const mPath = manifestPath(email);
  const { error: mErr } = await client.storage.from(STORAGE_BUCKET).upload(mPath, manifestBlob, {
    upsert: true,
    contentType: "application/json"
  });
  if (mErr) throw new Error(`マニフェストの保存に失敗: ${mErr.message}`);

  const row = {
    owner_email: email.toLowerCase().trim(),
    project_key: PROJECT_KEY,
    payload: manifest,
    updated_at: new Date().toISOString()
  };
  const { error: dbErr } = await client
    .from(SAVE_TABLE)
    .upsert(row, { onConflict: "owner_email,project_key" });
  if (dbErr) {
    console.warn("[workspace-cloud-save] DB upsert skipped:", dbErr.message);
  }

  return { savedAt: manifest.savedAt, takeCount: takeBlobs.size };
}

/**
 * @param {string} email
 * @returns {Promise<{ manifest: object, takeBlobs: Map<string, Blob> }|null>}
 */
export async function loadWorkspaceFromCloud(email) {
  const client = getClient();
  if (!client) return null;

  let manifest = null;

  const { data: row, error: rowErr } = await client
    .from(SAVE_TABLE)
    .select("payload, updated_at")
    .eq("owner_email", email.toLowerCase().trim())
    .eq("project_key", PROJECT_KEY)
    .maybeSingle();

  if (!rowErr && row?.payload) {
    manifest = row.payload;
    if (manifest && !manifest.savedAt && row.updated_at) {
      manifest.savedAt = row.updated_at;
    }
  }

  if (!manifest) {
    const mPath = manifestPath(email);
    const { data: file, error: dlErr } = await client.storage
      .from(STORAGE_BUCKET)
      .download(mPath);
    if (dlErr || !file) return null;
    const text = await file.text();
    manifest = JSON.parse(text);
  }

  if (!manifest?.version) return null;

  const takeBlobs = new Map();
  const takeIds = new Set();
  for (const linePack of Object.values(manifest.lines || {})) {
    for (const t of linePack.takes || []) {
      if (t?.id) takeIds.add(t.id);
    }
  }
  for (const tr of manifest.trash || []) {
    if (tr?.take?.id) takeIds.add(tr.take.id);
  }

  for (const takeId of takeIds) {
    const path = takeStoragePath(email, takeId);
    const { data: blob, error } = await client.storage.from(STORAGE_BUCKET).download(path);
    if (!error && blob) takeBlobs.set(takeId, blob);
  }

  return { manifest, takeBlobs };
}
