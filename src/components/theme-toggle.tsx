import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const order: Theme[] = ["light", "dark", "system"];
const icons: Record<Theme, React.ReactNode> = {
  light: <Sun className="h-4 w-4" />,
  dark: <Moon className="h-4 w-4" />,
  system: <Monitor className="h-4 w-4" />,
};
const labels: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const next = order[(order.indexOf(theme) + 1) % order.length]!;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setTheme(next)}
      className={cn("gap-2", className)}
      title={`Theme: ${labels[theme]} (click for ${labels[next]})`}
    >
      {icons[theme]}
      <span className="hidden sm:inline">{labels[theme]}</span>
    </Button>
  );
}
