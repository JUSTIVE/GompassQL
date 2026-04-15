import { Link, useNavigate } from "@tanstack/react-router";
import { FileCode, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useSchema } from "@/lib/schema-context";
import { deleteSchema, listSchemas, type SavedSchema } from "@/lib/storage";

export function SchemasRoute() {
  const [items, setItems] = useState<SavedSchema[]>(() => listSchemas());
  const { setSchema } = useSchema();
  const navigate = useNavigate();

  useEffect(() => {
    const refresh = () => setItems(listSchemas());
    window.addEventListener("gompassql:schemas-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("gompassql:schemas-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const open = (s: SavedSchema) => {
    setSchema({ sdl: s.sdl, name: s.name });
    navigate({ to: "/view" });
  };

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 overflow-auto px-6 py-10">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Saved schemas</h1>
          <p className="text-sm text-muted-foreground">
            {items.length === 0
              ? "No schemas yet. Save one from the landing page."
              : `${items.length} schema${items.length > 1 ? "s" : ""} stored locally.`}
          </p>
        </div>
        <Button asChild>
          <Link to="/">New schema</Link>
        </Button>
      </div>

      {items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            <FileCode className="mx-auto mb-3 h-8 w-8 opacity-40" />
            Paste an SDL on the{" "}
            <Link to="/" className="underline">
              landing page
            </Link>{" "}
            and click <span className="font-medium">Save & visualize</span>.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((s) => (
            <Card key={s.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">{s.name}</CardTitle>
                    <CardDescription className="text-xs">
                      Updated {new Date(s.updatedAt).toLocaleString()}
                    </CardDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteSchema(s.id)}
                    title="Delete schema"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-3">
                <pre className="line-clamp-3 overflow-hidden rounded bg-muted p-2 font-mono text-[10px] leading-snug text-muted-foreground">
                  {s.sdl.trim().slice(0, 240)}
                </pre>
                <Button size="sm" onClick={() => open(s)}>
                  Open in explorer
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
