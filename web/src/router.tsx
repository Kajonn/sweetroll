import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, useNavigate, useParams } from "@tanstack/react-router";

import { createApiClient, type ApiClient } from "./api/client.js";
import { createCharactersApi, type CharactersApi } from "./characters/api.js";
import { createCoordination } from "./characters/coordination.js";
import type { IdentityGate } from "./characters/identity.js";
import { CharacterDetail, NewCharacterRoute, useSharedCharacterStore } from "./characters/CharacterRoute.js";
import { t } from "./i18n/index.js";
import { DocumentEditor } from "./editor/DocumentEditor.js";
import { CloneFromTemplate } from "./library/CloneFromTemplate.js";
import { SystemLibrary } from "./library/SystemLibrary.js";
import { AppShell, useIdentity } from "./shell/AppShell.js";

const apiClient: ApiClient = createApiClient({ baseUrl: "/api" });

function useCharactersApi(): CharactersApi {
  return useMemo(() => createCharactersApi(createApiClient({ baseUrl: "/api" })), []);
}

/** Re-render route views when the shared identity gate publishes a new snapshot. */
function useIdentityTick(identity: IdentityGate | null): number {
  return useSyncExternalStore(
    onChange => (identity === null ? () => {} : identity.subscribe(onChange)),
    () => identity?.getSnapshot().generation ?? 0,
    () => 0,
  );
}

const rootRoute = createRootRoute({ component: () => <AppShell><Outlet /></AppShell> });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <LibraryRoute client={apiClient} />,
});
const systemRoute = createRoute({ getParentRoute: () => rootRoute, path: "/systems/$systemId", component: SystemEditorRoute });
const charactersNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/characters/new",
  validateSearch: (search: Record<string, unknown>) => ({
    systemVersionId: typeof search.systemVersionId === "string" ? search.systemVersionId : undefined,
  }),
  component: NewCharacterRouteView,
});
const characterDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/characters/$characterId",
  component: CharacterDetailRouteView,
});

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

function NewCharacterRouteView() {
  const search = charactersNewRoute.useSearch();
  const identity = useIdentity();
  useIdentityTick(identity);
  const store = useSharedCharacterStore();
  const api = useCharactersApi();
  const navigate = useNavigate();
  if (identity === null || store === undefined) {
    return <p role="status">{t("character.loading")}</p>;
  }
  return (
    <NewCharacterRoute
      api={api}
      store={store}
      identity={identity}
      initialSystemVersionId={search.systemVersionId}
      onCreated={characterId => void navigate({ to: "/characters/$characterId", params: { characterId } })}
    />
  );
}

function CharacterDetailRouteView() {
  const params = useParams({ strict: false });
  const characterId = params["characterId"] ?? "";
  const identity = useIdentity();
  useIdentityTick(identity);
  const store = useSharedCharacterStore();
  const api = useCharactersApi();
  const actorId = identity?.getActorId() ?? null;
  const coordination = useMemo(() => {
    if (actorId === null) return null;
    return createCoordination({ actorId, characterId });
  }, [actorId, characterId]);
  useEffect(() => () => coordination?.dispose(), [coordination]);
  if (identity === null || store === undefined || coordination === null) {
    if (identity !== null && actorId === null && store !== undefined) {
      return (
        <section aria-labelledby="character-detail-title">
          <h1 id="character-detail-title">{t("character.loading")}</h1>
          <p role="status">{t("character.detail.signIn")}</p>
        </section>
      );
    }
    return <p role="status">{t("character.loading")}</p>;
  }
  if (store === null) {
    return <p role="status">{t("shell.characterStorageUnavailable")}</p>;
  }
  return (
    <CharacterDetail
      characterId={characterId}
      api={api}
      store={store}
      identity={identity}
      coordination={coordination}
    />
  );
}

const routeTree = rootRoute.addChildren([indexRoute, systemRoute, charactersNewRoute, characterDetailRoute]);

export function createAppRouter() { return createRouter({ routeTree }); }
export const router = createAppRouter();
