/**
 * 収録ワークスペース — ページ離脱時の作業状態（テイク Blob 含む）を IndexedDB に一時保存
 */

const DB_NAME = "wavrick_rw_session_cache";
const DB_VERSION = 1;
const STORE_META = "meta";
const STORE_BLOBS = "blobs";
const META_KEY = "latest";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("IndexedDB を開けませんでした"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.target.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
    };
  });
}

/** @param {object} manifest @param {Map<string, Blob>} takeBlobsMap */
export async function saveWorkspaceSessionCache(manifest, takeBlobsMap) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META, STORE_BLOBS], "readwrite");
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve(true);
    tx.objectStore(STORE_META).put(manifest, META_KEY);
    const blobStore = tx.objectStore(STORE_BLOBS);
    blobStore.clear();
    if (takeBlobsMap?.size) {
      for (const [id, blob] of takeBlobsMap) {
        if (id && blob?.size > 0) blobStore.put(blob, id);
      }
    }
  });
}

/** @returns {Promise<{ manifest: object, takeBlobs: Map<string, Blob> }|null>} */
export async function loadWorkspaceSessionCache() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META, STORE_BLOBS], "readonly");
    tx.onerror = () => reject(tx.error);
    const metaReq = tx.objectStore(STORE_META).get(META_KEY);
    metaReq.onerror = () => reject(metaReq.error);
    metaReq.onsuccess = () => {
      const manifest = metaReq.result || null;
      if (!manifest) {
        resolve(null);
        return;
      }
      const blobStore = tx.objectStore(STORE_BLOBS);
      const keysReq = blobStore.getAllKeys();
      keysReq.onerror = () => reject(keysReq.error);
      keysReq.onsuccess = () => {
        const keys = keysReq.result || [];
        if (!keys.length) {
          resolve({ manifest, takeBlobs: new Map() });
          return;
        }
        const blobsReq = blobStore.getAll();
        blobsReq.onerror = () => reject(blobsReq.error);
        blobsReq.onsuccess = () => {
          const blobs = blobsReq.result || [];
          const takeBlobs = new Map();
          keys.forEach((key, i) => {
            const id = String(key);
            if (id && blobs[i]) takeBlobs.set(id, blobs[i]);
          });
          resolve({ manifest, takeBlobs });
        };
      };
    };
  });
}

export async function clearWorkspaceSessionCache() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META, STORE_BLOBS], "readwrite");
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve(true);
    tx.objectStore(STORE_META).delete(META_KEY);
    tx.objectStore(STORE_BLOBS).clear();
  });
}
