import { createRootRoute, createRoute, createRouter, Outlet, useParams } from "@tanstack/react-router";

import { createApiClient, type ApiClient } from "./api/client.js";
import { DocumentEditor } from "./editor/DocumentEditor.js";
import { CloneFromTemplate } from "./library/CloneFromTemplate.js";
import { SystemLibrary } from "./library/SystemLibrary.js";
import { AppShell } from "./shell/AppShell.js";

const apiClient: ApiClient = createApiClient({ baseUrl: "/api" });

const rootRoute = createRootRoute({ component: () => <AppShell><Outlet /></AppShell> });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <LibraryRoute client={apiClient} />,
});
const systemRoute = createRoute({ getParentRoute: () => rootRoute, path: "/systems/$systemId", component: SystemEditorRoute });

function SystemEditorRoute() {
  const params = useParams({ strict: false });
  const systemId = params["systemId"] ?? "";
  return <DocumentEditor client={apiClient} systemId={systemId} />;
}

function LibraryRoute({ client }: { client: ApiClient }) {
  return (
    <div data-testid="library-route">
      <SystemLibrary client={client} />
      <CloneFromTemplate client={client} />
    </div>
  );
}

const routeTree = rootRoute.addChildren([indexRoute, systemRoute]);

export function createAppRouter() { return createRouter({ routeTree }); }
export const router = createAppRouter();
