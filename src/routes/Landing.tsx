import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  History,
  Link2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SdlEditor } from "@/components/SdlEditor";
import { Button } from "@/components/ui/button";
import {
  deleteFileHandle,
  getFileHandle,
  isFileSystemAccessSupported,
  readLinkedFile,
  saveFileHandle,
} from "@/lib/file-handles";
import { SAMPLE_SDL } from "@/lib/sample-sdl";
import { useSchema } from "@/lib/schema-context";
import { sdlToGraph } from "@/lib/sdl-to-graph";
import {
  addOrUpdateEntry,
  clearHistory,
  formatTimestamp,
  hashSdl,
  type HistoryEntry,
  loadHistory,
  removeEntry,
} from "@/lib/schema-history";


const SDL_EXT_RE = /\.(graphql|graphqls|gql|sdl|txt)$/i;

function nameFromFile(file: File): string {
  return file.name.replace(SDL_EXT_RE, "") || file.name || "Untitled schema";
}

function defaultName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Schema ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LandingRoute() {
  const navigate = useNavigate();
  const { setSchema } = useSchema();
  const [sdl, setSdl] = useState("");
  const [derivedName, setDerivedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Linked-file state — set when the current SDL was loaded via the
  // File System Access API. Kept across edits so the Visualize step
  // knows to refetch the latest disk content before navigating.
  const [linkedFile, setLinkedFile] = useState<{
    name: string;
    handle: FileSystemFileHandle;
    /** Hash of the SDL that was last read from this handle — lets
     *  us decide whether the file changed on disk since the last
     *  load and keep the history entry's hash in sync. */
    lastHash: string;
  } | null>(null);
  const fsaSupported = isFileSystemAccessSupported();

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const historyMeta = useMemo(
    () =>
      history.map((entry) => {
        // Cheap regex-based counts. Previously called `sdlToGraph`
        // per entry, which runs the full graphql-js parser — on a
        // history list containing a 72k-line schema that crashes the
        // renderer with "Aw, Snap!" just from mounting the Landing
        // page. A couple of regex scans over the string avoid ever
        // materializing an AST.
        const sdl = entry.sdl;
        const countMatches = (re: RegExp) => {
          let n = 0;
          for (const _ of sdl.matchAll(re)) n++;
          return n;
        };
        const types =
          countMatches(/^\s*type\s+\w+/gm) +
          countMatches(/^\s*interface\s+\w+/gm) +
          countMatches(/^\s*input\s+\w+/gm);
        const enums = countMatches(/^\s*enum\s+\w+/gm);
        const unions = countMatches(/^\s*union\s+\w+/gm);
        const parts: string[] = [];
        if (types) parts.push(`${types} types`);
        if (enums) parts.push(`${enums} enums`);
        if (unions) parts.push(`${unions} unions`);
        const lines = sdl.split("\n").length;
        parts.push(`${lines} lines`);
        const hash6 = entry.hash.slice(0, 6).padStart(6, "0");
        return { summary: parts.join(" · "), hash6 };
      }),
    [history],
  );

  const readFile = async (file: File) => {
    try {
      const text = await file.text();
      setSdl(text);
      setDerivedName(nameFromFile(file));
      setError(null);
      setWarnings([]);
      // One-shot upload — disconnect any prior link.
      setLinkedFile(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read file.");
    }
  };

  /**
   * Pick a file via the File System Access API and remember the
   * handle so we can re-read the same file later. Falls back to a
   * one-shot read on browsers without the API (Firefox/Safari).
   */
  const pickLinkedFile = async () => {
    if (!fsaSupported) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const picker = (window as unknown as {
        showOpenFilePicker: (opts?: {
          types?: { description: string; accept: Record<string, string[]> }[];
          multiple?: boolean;
        }) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker;
      const picked = await picker({
        multiple: false,
        types: [
          {
            description: "GraphQL SDL",
            accept: {
              "text/plain": [".graphql", ".graphqls", ".gql", ".sdl", ".txt"],
            },
          },
        ],
      });
      const handle = picked[0];
      if (!handle) return;
      const file = await handle.getFile();
      const text = await file.text();
      setSdl(text);
      setDerivedName(handle.name.replace(SDL_EXT_RE, "") || handle.name);
      setError(null);
      setWarnings([]);
      setLinkedFile({ name: handle.name, handle, lastHash: hashSdl(text) });
    } catch (e) {
      // User cancelled (AbortError) is silent; otherwise surface.
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Failed to open file.");
    }
  };

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setIsDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setIsDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) void readFile(f);
    };

    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  const validate = () => {
    const trimmed = sdl.trim();
    if (!trimmed) {
      setError("Paste an SDL or drop a .graphql file.");
      setWarnings([]);
      return null;
    }
    const graph = sdlToGraph(trimmed);
    if (graph.error) {
      setError(graph.error);
      setWarnings([]);
      return null;
    }
    if (graph.nodes.length === 0) {
      setError("No types found in this SDL.");
      setWarnings([]);
      return null;
    }
    if (graph.warnings.length > 0) {
      setError(null);
      setWarnings(graph.warnings);
      return null;
    }
    setError(null);
    setWarnings([]);
    return { sdl: trimmed, name: derivedName ?? defaultName() };
  };

  const visualize = async () => {
    // For linked schemas, refetch the on-disk content first so the
    // visualization reflects the latest version even when the
    // editor still shows a stale snapshot. Skipped silently when the
    // user has declined permission or the handle is invalid.
    if (linkedFile) {
      const fresh = await readLinkedFile(linkedFile.handle);
      if (fresh !== null && fresh !== sdl) {
        setSdl(fresh);
      }
      const finalSdl = fresh ?? sdl;
      const trimmed = finalSdl.trim();
      if (!trimmed) {
        setError("Linked file is empty.");
        return;
      }
      const graph = sdlToGraph(trimmed);
      if (graph.error) {
        setError(graph.error);
        return;
      }
      const name = derivedName ?? defaultName();
      const fileName = linkedFile.name;
      const newHash = hashSdl(trimmed);
      setSchema({ sdl: trimmed, name });
      setHistory((h) => addOrUpdateEntry(h, trimmed, name, fileName));
      // Save the handle keyed by the new hash so a future revisit of
      // this entry refetches the same file.
      await saveFileHandle(newHash, linkedFile.handle);
      // If the on-disk content drifted from the previous hash, clean
      // up the old IndexedDB row.
      if (newHash !== linkedFile.lastHash) {
        await deleteFileHandle(linkedFile.lastHash);
      }
      setLinkedFile({ ...linkedFile, lastHash: newHash });
      navigate({ to: "/view" });
      return;
    }
    const v = validate();
    if (!v) return;
    setSchema({ sdl: v.sdl, name: v.name });
    setHistory((h) => addOrUpdateEntry(h, v.sdl, v.name));
    navigate({ to: "/view" });
  };

  const loadFromHistory = async (entry: HistoryEntry) => {
    // If the entry is linked to a file handle, re-request permission
    // and refetch the latest content. Fall back to the cached SDL
    // when the user declines or the file is gone.
    if (entry.linkedFile) {
      const handle = await getFileHandle(entry.hash);
      if (handle) {
        const fresh = await readLinkedFile(handle);
        if (fresh !== null) {
          setSdl(fresh);
          setDerivedName(entry.name);
          setError(null);
          setWarnings([]);
          setLinkedFile({
            name: entry.linkedFile,
            handle,
            lastHash: entry.hash,
          });
          return;
        }
      }
      // Permission denied or handle vanished — surface a soft notice
      // and fall through to loading the cached SDL.
      setError(
        `Couldn't re-read linked file "${entry.linkedFile}" — showing the last cached copy. Re-link to refresh.`,
      );
    } else {
      setLinkedFile(null);
    }
    setSdl(entry.sdl);
    setDerivedName(entry.name);
    if (!entry.linkedFile) {
      setError(null);
    }
    setWarnings([]);
  };

  const deleteHistoryEntry = (hash: string) => {
    setHistory((h) => removeEntry(h, hash));
    // Also drop any IndexedDB handle keyed by the same hash so we
    // don't leak file handles forever.
    void deleteFileHandle(hash);
  };

  const resetHistory = () => {
    setHistory(clearHistory());
  };


  return (
    <div className="absolute inset-0 mx-auto flex w-full max-w-3xl flex-col gap-4 overflow-hidden px-6 py-6">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight">
          Visualize your GraphQL schema
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop a <code className="rounded bg-muted px-1 font-mono text-[11px]">.graphql</code>{" "}
          file, pick one, or paste SDL below. Parsed once, then opens an
          interactive explorer.
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".graphql,.graphqls,.gql,.sdl,.txt,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" />
          Open file
        </Button>
        {fsaSupported && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => void pickLinkedFile()}
            title="Link a file — Visualize re-reads the latest disk content each time"
          >
            <Link2 className="h-3.5 w-3.5" />
            Link file
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => {
            setSdl(SAMPLE_SDL);
            setDerivedName("Sample blog schema");
            setError(null);
          }}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Load sample
        </Button>
        {derivedName && (
          <span className="ml-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
            {linkedFile && (
              <Link2
                className="h-3 w-3 shrink-0 text-primary"
              />
            )}
            {derivedName}
          </span>
        )}
      </div>

      {history.length > 0 && (
        <div className="shrink-0 rounded-md border border-border bg-card">
          <div className="flex items-center justify-between px-3 py-2">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {historyOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <History className="h-3.5 w-3.5" />
              <span>Recent schemas ({history.length})</span>
            </button>
            {historyOpen && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive"
                onClick={resetHistory}
              >
                <Trash2 className="h-3 w-3" />
                Clear
              </Button>
            )}
          </div>
          {historyOpen && (
            <ul className="max-h-48 overflow-auto border-t border-border">
              {history.map((entry, i) => {
                const meta = historyMeta[i];
                return (
                <li
                  key={entry.hash}
                  className="group flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-b-0 hover:bg-secondary/40"
                >
                  <button
                    type="button"
                    onClick={() => void loadFromHistory(entry)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                  >
                    <span className="flex w-full items-center gap-1 truncate text-sm font-medium">
                      {entry.linkedFile && (
                        <Link2
                          className="h-3 w-3 shrink-0 text-primary"
                        />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {entry.updatedAt !== entry.createdAt ? "updated " : "added "}
                      {formatTimestamp(entry.updatedAt)}
                    </span>
                    {meta && (
                      <span className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                        {meta.summary}
                        <span className="ml-1.5 rounded bg-muted px-1 py-px">{meta.hash6}</span>
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Remove from history"
                    onClick={() => deleteHistoryEntry(entry.hash)}
                    className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-destructive group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-card">
        <SdlEditor
          value={sdl}
          onChange={(v) => {
            setSdl(v);
            if (derivedName) setDerivedName(null);
            if (warnings.length) setWarnings([]);
          }}
          placeholder="# Paste your GraphQL SDL here…"
        />
      </div>

      {error && (
        <div className="flex max-h-32 shrink-0 items-start gap-2 overflow-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <pre className="whitespace-pre-wrap font-mono">{error}</pre>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <div className="mb-1.5 flex items-center gap-1.5 font-medium">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            Schema has duplicate or conflicting type declarations — fix before visualizing
          </div>
          <ul className="space-y-0.5 font-mono">
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <Button onClick={visualize} size="lg" className="gap-2">
          <Wand2 className="h-4 w-4" />
          Visualize
        </Button>
      </div>

      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-primary bg-card px-12 py-10 text-center shadow-xl">
            <Upload className="mx-auto h-10 w-10 text-primary" />
            <p className="mt-3 text-lg font-semibold">Drop your SDL file</p>
            <p className="mt-1 text-xs text-muted-foreground">
              .graphql · .graphqls · .gql · .sdl · .txt
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
