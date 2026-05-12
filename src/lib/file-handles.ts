/**
 * IndexedDB-backed cache for `FileSystemFileHandle` references. The
 * File System Access API lets the user pick a file once and reopen
 * it in later sessions, but the handle itself isn't a serializable
 * value — we have to keep it in IndexedDB and re-read the file
 * content (with a re-permission request) on each visit.
 *
 * Keyed by the schema's SDL hash so the same key joins the
 * HistoryEntry stored in `localStorage` with the matching handle
 * here.
 */

const DB_NAME = "gompassql-handles";
const STORE = "handles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

export async function saveFileHandle(
  hash: string,
  handle: FileSystemFileHandle,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // best-effort cache; ignore errors
  }
}

export async function getFileHandle(
  hash: string,
): Promise<FileSystemFileHandle | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return await new Promise<FileSystemFileHandle | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(hash);
      req.onsuccess = () =>
        resolve((req.result as FileSystemFileHandle | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function deleteFileHandle(hash: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}

/**
 * Re-read the file via a saved handle, asking for read permission
 * if it has lapsed. Returns the file text on success or null when
 * the user declines or the handle is no longer valid (file moved /
 * deleted on disk).
 */
export async function readLinkedFile(
  handle: FileSystemFileHandle,
): Promise<string | null> {
  try {
    // The `as any` cast is needed because TypeScript's lib.dom
    // doesn't expose queryPermission / requestPermission on
    // FileSystemHandle yet — but they ship in Chromium browsers.
    const h = handle as unknown as {
      queryPermission?: (opts: { mode: "read" }) => Promise<PermissionState>;
      requestPermission?: (opts: { mode: "read" }) => Promise<PermissionState>;
      getFile: () => Promise<File>;
    };
    if (h.queryPermission) {
      const current = await h.queryPermission({ mode: "read" });
      if (current !== "granted" && h.requestPermission) {
        const next = await h.requestPermission({ mode: "read" });
        if (next !== "granted") return null;
      }
    }
    const file = await h.getFile();
    return await file.text();
  } catch {
    return null;
  }
}
