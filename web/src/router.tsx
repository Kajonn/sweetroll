import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";

import { AppShell } from "./shell/AppShell.js";

const rootRoute = createRootRoute({ component: () => <AppShell><Outlet /></AppShell> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <div data-testid="library-placeholder">Library</div> });
const systemRoute = createRoute({ getParentRoute: () => rootRoute, path: "/systems/$systemId", component: () => <div data-testid="system-placeholder">System</div> });

const routeTree = rootRoute.addChildren([indexRoute, systemRoute]);

export function createAppRouter() { return createRouter({ routeTree }); }
export const router = createAppRouter();
