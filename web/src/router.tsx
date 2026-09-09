import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, useNavigate, useParams } from "@tanstack/react-router";

import { createApiClient, type ApiClient } from "./api/client.js";
import { createCharactersApi, type CharactersApi } from "./characters/api.js";
import { createCoordination } from "./characters/coordination.js";
import type { BrowserChannel } from "./characters/identity.js";
import type { IdentityGate } from "./characters/identity.js";
import { CharacterDetail, NewCharacterRoute, useSharedCharacterStore } from "./characters/CharacterRoute.js";
import { CharacterLibrary } from "./player/CharacterLibrary.js";
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

export type RouteCoordination = ReturnType<typeof createCoordination>;

export type CoordinationPorts = { locks?: LockManager | null; channel?: BrowserChannel | null };

/**
 * Own the character editing/synchronization handle for one route lifetime.
 * The handle is created in the effect (not memoized): StrictMode re-runs
 * setup/cleanup on the same mounted tree, and disposing a memoized handle
 * would poison the reused instance so the session could never acquire the
 * Web Lock. Each setup therefore gets a fresh handle; cleanup still
 * releases it so real unmounts never leak the lock.
 */
export function useCharacterCoordination(
  actorId: string | null,
  characterId: string,
  ports?: CoordinationPorts,
): RouteCoordination | null {
  const [coordination, setCoordination] = useState<RouteCoordination | null>(null);
  useEffect(() => {
    if (actorId === null) {
      setCoordination(null);
      return;
    }
    const raw = createCoordination({ actorId, characterId, ...ports });
    let disposed = false;
    const wrapped: RouteCoordination = {
      ...raw,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        raw.dispose?.();
      },
    };
    setCoordination(wrapped);
    return () => {
      wrapped.dispose();
    };
    // Ports are test-only construction seams; the live route always uses
    // the browser defaults for a given actor/character.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, characterId]);
  return coordination;
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
const charactersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/characters",
  component: CharacterLibraryRouteView,
});
const characterDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/characters/$characterId",
  component: CharacterDetailRouteView,
});

function SystemEditorRoute() {
  const params = useParams({ strict: false });
  const systemId = params["systemId"] ?? "";
  const identity = useIdentity();
  useIdentityTick(identity);
  if (identity === null) {
    return <p role="status">{t("editor.loading")}</p>;
  }
  const actorId = identity.getActorId();
  if (actorId === null) {
    // Anonymous never sees the editor: sign-out unmounts the protected view
    // (mirroring CharacterDetailRouteView) instead of leaving system data
    // mounted with no identity.
    return (
      <section aria-labelledby="system-editor-title">
        <h1 id="system-editor-title">{t("editor.loading")}</h1>
        <p role="status">{t("character.detail.signIn")}</p>
      </section>
    );
  }
  const generation = identity.getGeneration?.() ?? 0;
  return (
    <DocumentEditor
      key={`${actorId}:${generation}:${systemId}`}
      client={apiClient}
      systemId={systemId}
      actorId={actorId}
      generation={generation}
    />
  );
}

function LibraryRoute({ client }: { client: ApiClient }) {
  return (
    <div data-testid="library-route">
      <SystemLibrary client={client} />
      <CloneFromTemplate client={client} />
    </div>
  );
}

function CharacterLibraryRouteView() {
  const identity = useIdentity();
  useIdentityTick(identity);
  const api = useCharactersApi();
  const navigate = useNavigate();
  if (identity === null) {
    return <p role="status">{t("character.loading")}</p>;
  }
  return (
    <CharacterLibrary
      key={libraryViewKey(identity.getActorId(), identity.getGeneration?.() ?? 0)}
      api={api}
      identity={identity}
      navigation={{
        onOpenCharacter: characterId => {
          void navigate({ to: "/characters/$characterId", params: { characterId } });
        },
        onCreateNew: () => {
          void navigate({ to: "/characters/new" });
        },
      }}
    />
  );
}

/**
 * Account-lifetime key for the library view: the infinite-query cache is
 * already lifetime scoped (see characterLibraryKey), and the route remounts
 * on lifetime change so search/filter/duplicate state never leaks across
 * accounts.
 */
export function libraryViewKey(actorId: string | null, generation: number): string {
  return `${actorId ?? "signed-out"}:${generation}`;
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
      key={creationViewKey(identity.getActorId(), identity.getGeneration?.() ?? 0, search.systemVersionId)}
      api={api}
      store={store}
      identity={identity}
      initialSystemVersionId={search.systemVersionId}
      onCreated={characterId => void navigate({ to: "/characters/$characterId", params: { characterId } })}
    />
  );
}

/**
 * Account-lifetime key for the creation view: actor-specific component state
 * (pending attempts, restored fields, in-flight submissions) must never
 * survive an account switch or generation invalidation, so the route
 * remounts when the lifetime changes as well as when the version input does.
 */
export function creationViewKey(
  actorId: string | null,
  generation: number,
  systemVersionId: string | undefined,
): string {
  return `${actorId ?? "signed-out"}:${generation}:${systemVersionId ?? ""}`;
}

function CharacterDetailRouteView() {
  const params = useParams({ strict: false });
  const characterId = params["characterId"] ?? "";
  const identity = useIdentity();
  useIdentityTick(identity);
  const store = useSharedCharacterStore();
  const api = useCharactersApi();
  const navigate = useNavigate();
  const actorId = identity?.getActorId() ?? null;
  // Coordination ownership: each effect setup owns a fresh handle (see
  // useCharacterCoordination); cleanup releases it. A disposed handle is
  // never reused, so StrictMode setup/cleanup/setup cannot wedge the lock.
  const coordination = useCharacterCoordination(actorId, characterId);
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
      navigation={{
        onCreateNew: () => {
          void navigate({ to: "/characters/new" });
        },
        onOpenLibrary: () => {
          void navigate({ to: "/" });
        },
        onOpenCharacter: nextId => {
          void navigate({ to: "/characters/$characterId", params: { characterId: nextId } });
        },
      }}
    />
  );
}

const routeTree = rootRoute.addChildren([indexRoute, systemRoute, charactersRoute, charactersNewRoute, characterDetailRoute]);

export function createAppRouter() { return createRouter({ routeTree }); }
export const router = createAppRouter();
