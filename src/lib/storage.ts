const KEY = "gompassql:schemas";

export interface SavedSchema {
  id: string;
  name: string;
  sdl: string;
  updatedAt: number;
}

function read(): SavedSchema[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(all: SavedSchema[]) {
  localStorage.setItem(KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("gompassql:schemas-changed"));
}

export function listSchemas(): SavedSchema[] {
  return read().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSchema(id: string): SavedSchema | undefined {
  return read().find((s) => s.id === id);
}

export function upsertSchema(input: { id?: string; name: string; sdl: string }): SavedSchema {
  const all = read();
  const id = input.id ?? crypto.randomUUID();
  const next: SavedSchema = {
    id,
    name: input.name.trim() || "Untitled schema",
    sdl: input.sdl,
    updatedAt: Date.now(),
  };
  const idx = all.findIndex((s) => s.id === id);
  if (idx >= 0) all[idx] = next;
  else all.push(next);
  write(all);
  return next;
}

export function deleteSchema(id: string) {
  write(read().filter((s) => s.id !== id));
}
