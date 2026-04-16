import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { AboutRoute } from "./About";
import { LandingRoute } from "./Landing";
import { ViewRoute } from "./View";

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LandingRoute,
});

const viewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/view",
  component: ViewRoute,
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: AboutRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  viewRoute,
  aboutRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
