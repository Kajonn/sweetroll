import { createRootRoute, createRoute, createRouter, Outlet, useParams } from "@tanstack/react-router";

import { createApiClient, type ApiClient } from "./api/client.js";
import { DocumentEditor } from "./editor/DocumentEditor.js";
import { AppShell } from "./shell/AppShell.js";

const apiClient: ApiClient = createApiClient({ baseUrl: "/api" });

const rootRoute = createRootRoute({ component: () => <AppShell><Outlet /></AppShell> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <div data-testid="library-placeholder">Library</div> });
const systemRoute = createRoute({ getParentRoute: () => rootRoute, path: "/systems/$systemId", component: SystemEditorRoute });

function SystemEditorRoute() {
  const params = useParams({ strict: false });
  const systemId = params["systemId"] ?? "";
  return <DocumentEditor client={apiClient} systemId={systemId} />;
}

const routeTree = rootRoute.addChildren([indexRoute, systemRoute]);

export function createAppRouter() { return createRouter({ routeTree }); }
export const router = createAppRouter();
