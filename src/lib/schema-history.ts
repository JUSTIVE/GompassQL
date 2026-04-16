export interface HistoryEntry {
  hash: string;
  sdl: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "gompassql:history";
const MAX_ENTRIES = 10;

export function hashSdl(sdl: string): string {
  const s = sdl.trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is HistoryEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as HistoryEntry).hash === "string" &&
        typeof (e as HistoryEntry).sdl === "string" &&
        typeof (e as HistoryEntry).name === "string" &&
        typeof (e as HistoryEntry).createdAt === "number" &&
        typeof (e as HistoryEntry).updatedAt === "number",
    );
  } catch {
    return [];
  }
}

function save(entries: HistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore quota / serialization errors
  }
}

export function addOrUpdateEntry(
  entries: HistoryEntry[],
  sdl: string,
  name: string,
): HistoryEntry[] {
  const hash = hashSdl(sdl);
  const now = Date.now();
  const existing = entries.find((e) => e.hash === hash);
  const rest = entries.filter((e) => e.hash !== hash);
  const next: HistoryEntry = existing
    ? { ...existing, name, sdl, updatedAt: now }
    : { hash, sdl, name, createdAt: now, updatedAt: now };
  const merged = [next, ...rest].slice(0, MAX_ENTRIES);
  save(merged);
  return merged;
}

export function removeEntry(
  entries: HistoryEntry[],
  hash: string,
): HistoryEntry[] {
  const next = entries.filter((e) => e.hash !== hash);
  save(next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  return [];
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
