import { RouterProvider } from "@tanstack/react-router";
import { SchemaProvider } from "@/lib/schema-context";
import { ThemeProvider } from "@/lib/theme";
import { router } from "@/routes/router";
import "./index.css";

export function App() {
  return (
    <ThemeProvider>
      <SchemaProvider>
        <RouterProvider router={router} />
      </SchemaProvider>
    </ThemeProvider>
  );
}

export default App;
