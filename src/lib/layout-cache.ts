import type { LayoutResult } from "./layout";
import type { GraphEdgeData, GraphNodeData } from "./sdl-to-graph";
import type { LayoutNodeInput } from "./layout";

/**
 * Persistent LayoutResult cache backed by IndexedDB. Keyed by a
 * content hash of the layout-relevant inputs — pasting the same SDL
 * twice returns an identical, already-laid-out result instantly.
 *
 * Cache hit cost: ~0–2ms (async fetch + structured clone).
 * Cache miss cost: 0 (just returns null).
 *
 * Bumping CACHE_VERSION invalidates every stored entry — use when
 * the layout pipeline output shape changes.
 */

const DB_NAME = "gompassql-layout-cache";
const DB_VERSION = 1;
const STORE = "results";
const MAX_ENTRIES = 20;
const CACHE_VERSION = "v1";

interface CacheEntry {
  hash: string;
  result: LayoutResult;
  createdAt: number;
  accessedAt: number;
  nodeCount: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "hash" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export async function cacheGet(hash: string): Promise<LayoutResult | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE);
    const g = store.get(hash);
    g.onsuccess = () => {
      const entry = g.result as CacheEntry | undefined;
      if (!entry) {
        resolve(null);
        return;
      }
      entry.accessedAt = Date.now();
      try {
        store.put(entry);
      } catch {
        // best-effort
      }
      resolve(entry.result);
    };
    g.onerror = () => resolve(null);
  });
}

export async function cachePut(
  hash: string,
  result: LayoutResult,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const now = Date.now();
    const entry: CacheEntry = {
      hash,
      result,
      createdAt: now,
      accessedAt: now,
      nodeCount: result.nodes.length,
    };
    try {
      store.put(entry);
    } catch {
      // quota / clone failure — swallow
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  await trimIfNeeded(db);
}

async function trimIfNeeded(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const n = countReq.result;
      if (n <= MAX_ENTRIES) {
        resolve();
        return;
      }
      const toDelete = n - MAX_ENTRIES;
      const entries: CacheEntry[] = [];
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (c) {
          entries.push(c.value as CacheEntry);
          c.continue();
        } else {
          entries.sort((a, b) => a.accessedAt - b.accessedAt);
          for (let i = 0; i < toDelete && i < entries.length; i++) {
            store.delete(entries[i]!.hash);
          }
        }
      };
      cursorReq.onerror = () => {
        // leave it over-size rather than corrupt
      };
    };
    countReq.onerror = () => resolve();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/**
 * Content-hash the inputs that actually feed layout. Including the
 * cache version prefix ensures a pipeline change (captured as a
 * version bump) invalidates existing entries.
 */
export async function hashLayoutInputs(input: {
  nodes: readonly GraphNodeData[];
  edges: readonly GraphEdgeData[];
  layoutNodes: readonly LayoutNodeInput[];
}): Promise<string> {
  const source = JSON.stringify({
    v: CACHE_VERSION,
    layoutNodes: input.layoutNodes,
    edges: input.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
    })),
    // Union members feed similarity hints, so they affect layout output.
    unions: input.nodes
      .filter((n) => n.kind === "Union")
      .map((n) => ({
        id: n.id,
        members: (n.members ?? []).slice().sort(),
      })),
  });
  const buf = new TextEncoder().encode(source);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hashBuf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}
