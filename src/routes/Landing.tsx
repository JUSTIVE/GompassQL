import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, Save, Sparkles, Upload, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SdlEditor } from "@/components/SdlEditor";
import { Button } from "@/components/ui/button";
import { SAMPLE_SDL } from "@/lib/sample-sdl";
import { useSchema } from "@/lib/schema-context";
import { sdlToGraph } from "@/lib/sdl-to-graph";
import { upsertSchema } from "@/lib/storage";

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
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readFile = async (file: File) => {
    try {
      const text = await file.text();
      setSdl(text);
      setDerivedName(nameFromFile(file));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read file.");
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
      return null;
    }
    const graph = sdlToGraph(trimmed);
    if (graph.error) {
      setError(graph.error);
      return null;
    }
    if (graph.nodes.length === 0) {
      setError("No types found in this SDL.");
      return null;
    }
    setError(null);
    return { sdl: trimmed, name: derivedName ?? defaultName() };
  };

  const visualize = () => {
    const v = validate();
    if (!v) return;
    setSchema({ sdl: v.sdl, name: v.name });
    navigate({ to: "/view" });
  };

  const saveAndVisualize = () => {
    const v = validate();
    if (!v) return;
    upsertSchema({ name: v.name, sdl: v.sdl });
    setSchema({ sdl: v.sdl, name: v.name });
    navigate({ to: "/view" });
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
          <span className="ml-1 truncate text-xs text-muted-foreground">
            {derivedName}
          </span>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-card">
        <SdlEditor
          value={sdl}
          onChange={(v) => {
            setSdl(v);
            if (derivedName) setDerivedName(null);
          }}
          placeholder="# Paste your GraphQL SDL here…"
        />
      </div>

      {error ? (
        <div className="flex max-h-32 shrink-0 items-start gap-2 overflow-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <pre className="whitespace-pre-wrap font-mono">{error}</pre>
        </div>
      ) : null}

      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={saveAndVisualize} className="gap-2">
          <Save className="h-4 w-4" />
          Save & visualize
        </Button>
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
