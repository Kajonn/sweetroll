import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { CharacterTools } from "./CharacterTools.js";
import type { CharactersApi } from "./api.js";
import type { CharacterSession, CharacterSnapshot } from "./session.js";
import { makeView } from "./testing.js";
import type { CharacterExport, MigrationPreviewResponse } from "./types.js";

function readySnapshot(overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  return {
    phase: "ready",
    confirmed: makeView({ characterId: "char-1", revision: 3 }),
    tentative: null,
    entries: [],
    editing: { owned: true },
    error: null,
    lastRoll: null,
    lastMigration: null,
    pendingOnlineAttempts: [],
    connected: true,
    ...overrides,
  };
}

function makeSession(snapshot: CharacterSnapshot): CharacterSession {
  const listeners = new Set<(s: CharacterSnapshot) => void>();
  return {
    open: vi.fn(async () => {}),
    getSnapshot: () => snapshot,
    subscribe: (l: (s: CharacterSnapshot) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    setField: vi.fn(async () => {}),
    bumpResource: vi.fn(async () => {}),
    executeAction: vi.fn(async () => {}),
    resolveConflict: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
    commitMigration: vi.fn(async (_previewId: string) => {}),
    rollbackMigration: vi.fn(async (_migrationId: string) => {}),
    reviewExpiredAttempt: vi.fn(async () => {}),
    fetchActivityPage: vi.fn(async () => ({ events: [], nextCursor: null, stale: false, fetchedAt: "2026-09-06T00:00:00.000Z" })),
    requestEditing: vi.fn(async () => true),
    whenIdle: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as unknown as CharacterSession;
}

function makeApi(overrides: Partial<CharactersApi> = {}): CharactersApi {
  return {
    open: vi.fn(async () => ({ character: makeView({ characterId: "char-1", revision: 3 }), requestId: "r" })),
    creationOptions: vi.fn(async () => {
      throw new Error("unused");
    }),
    activity: vi.fn(async () => ({ events: [], nextCursor: null, requestId: "r" })),
    send: vi.fn(async () => {
      throw new Error("unused");
    }),
    export: vi.fn(async () => ({
      schemaVersion: "1.0",
      mediaType: "application/vnd.sweetroll.character+json;version=1",
      characterId: "char-1",
      name: "Aria",
      entityDefinitionId: "hero",
      lifecycle: "active",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      systemVersionId: "11111111-1111-4000-8000-000000000000",
      packageChecksum: "abc",
      revision: 3,
      state: { schemaVersion: "1.0", values: {} },
      migrationLineage: [],
    })),
    previewMigration: vi.fn(async () => {
      throw new Error("unused");
    }),
    ...overrides,
  } as unknown as CharactersApi;
}

describe("CharacterTools", () => {
  let urls: string[];
  let originalCreate: typeof URL.createObjectURL | undefined;
  let originalRevoke: typeof URL.revokeObjectURL | undefined;

  beforeEach(() => {
    urls = [];
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    (URL as unknown as Record<string, unknown>).createObjectURL = (() => {
      const url = "blob:export";
      urls.push(url);
      return url;
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn(() => {}) as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    if (originalCreate) URL.createObjectURL = originalCreate;
    if (originalRevoke) URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it("disables export while a pending edit exists", () => {
    const pending = readySnapshot({
      tentative: { name: "Briar" },
      entries: [
        {
          id: "e1",
          actorId: "a",
          characterId: "char-1",
          sequence: 0,
          baseRevision: 3,
          packageChecksum: "abc",
          createdAt: "2026-09-06T00:00:00.000Z",
          intent: { kind: "setField", fieldId: "name", value: "Briar" },
          attempt: null,
        },
      ],
    });
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(pending)} />);
    const exportButton = screen.getByRole("button", { name: /export/i });
    expect(exportButton).toBeDisabled(); // pending edit exists
  });

  it("downloads the server export document and cleans up the object URL", async () => {
    const user = userEvent.setup();
    const document = {
      schemaVersion: "1.0",
      mediaType: "application/vnd.sweetroll.character+json;version=1",
      characterId: "char-1",
      name: "Aria",
      entityDefinitionId: "hero",
      lifecycle: "active",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      systemVersionId: "11111111-1111-4000-8000-000000000000",
      packageChecksum: "abc",
      revision: 3,
      state: { schemaVersion: "1.0", values: { name: "Aria" } },
      migrationLineage: [],
    } as unknown as CharacterExport;
    const api = makeApi({ export: vi.fn(async () => document) });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {});
    render(<CharacterTools characterId="char-1" api={api} session={makeSession(readySnapshot())} />);
    await user.click(screen.getByRole("button", { name: /export/i }));
    await user.click(screen.getByRole("button", { name: /download export/i }));
    await waitFor(() => expect(api.export).toHaveBeenCalledWith("char-1"));
    expect(clickSpy).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export");
    clickSpy.mockRestore();
  });

  it("marks an archived character read-only until recovered", async () => {
    const user = userEvent.setup();
    const archived = readySnapshot({
      confirmed: makeView({ characterId: "char-1", revision: 4, lifecycle: "archived" }),
    });
    const session = makeSession(archived);
    render(<CharacterTools characterId="char-1" api={makeApi()} session={session} />);
    expect(screen.getByText(/read-only|archived/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /recover/i }));
    await user.click(screen.getByRole("button", { name: /confirm recover/i }));
    expect(session.recover).toHaveBeenCalledTimes(1);
  });

  it("pages activity with server cursors and reopens the last page stale after going offline", async () => {
    const user = userEvent.setup();
    const first = {
      events: [
        { id: "a1", characterRevision: 3, kind: "field-set", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T00:00:00.000Z" },
      ],
      nextCursor: "cursor-1" as string | null,
      stale: false,
      fetchedAt: "2026-09-06T01:00:00.000Z",
    };
    const second = {
      events: [
        { id: "a2", characterRevision: 4, kind: "bump", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T02:00:00.000Z" },
      ],
      nextCursor: null as string | null,
      stale: false,
      fetchedAt: "2026-09-06T03:00:00.000Z",
    };
    const fetchActivityPage = vi.fn(async (cursor: string | null) => (cursor === null ? first : second));
    const session = makeSession(readySnapshot());
    (session.fetchActivityPage as unknown as typeof fetchActivityPage) = fetchActivityPage;
    const api = makeApi();
    render(<CharacterTools characterId="char-1" api={api} session={session} />);
    await user.click(screen.getByRole("button", { name: /activity/i }));
    await waitFor(() => expect(screen.getByText(/field-set/)).toBeVisible());
    await user.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getByText(/bump/)).toBeVisible());
    expect(fetchActivityPage).toHaveBeenLastCalledWith("cursor-1");
    expect(api.activity).not.toHaveBeenCalled();
    // Close, go offline, reopen: the last fetched page shows marked stale.
    await user.click(screen.getByRole("button", { name: /^close$/i }));
    fetchActivityPage.mockImplementation(async () => ({ ...second, stale: true }));
    await user.click(screen.getByRole("button", { name: /activity/i }));
    await waitFor(() => expect(screen.getByText(/bump/)).toBeVisible());
    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0);
  });

  it("shows migration warnings and requires re-preview when expired", async () => {
    const user = userEvent.setup();
    const preview = {
      preview: {
        previewId: "p-1",
        characterId: "char-1",
        sourceRevision: 3,
        sourceVersionId: "11111111-1111-4000-8000-000000000000",
        targetVersionId: "22222222-2222-4000-8000-000000000000",
        candidateState: { schemaVersion: "1.0", values: {} },
        candidateProjection: {},
        warnings: ["Type change on health"],
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
      requestId: "r",
    } as unknown as MigrationPreviewResponse;
    const api = makeApi({ previewMigration: vi.fn(async () => preview) });
    const session = makeSession(readySnapshot());
    render(<CharacterTools characterId="char-1" api={api} session={session} now={() => "2026-09-06T00:00:00.000Z"} />);
    await user.click(screen.getByRole("button", { name: /migration/i }));
    await user.type(screen.getByLabelText(/target version/i), "22222222-2222-4000-8000-000000000000");
    await user.click(screen.getByRole("button", { name: /preview migration/i }));
    await waitFor(() => expect(screen.getByText(/Type change on health/)).toBeVisible());
    expect(screen.getByText(/expired|re-preview/i)).toBeVisible();
    expect(session.commitMigration).not.toHaveBeenCalled();
  });

  it("does not start lifecycle work while edits are pending", async () => {
    const pending = readySnapshot({
      entries: [
        {
          id: "e1",
          actorId: "a",
          characterId: "char-1",
          sequence: 0,
          baseRevision: 3,
          packageChecksum: "abc",
          createdAt: "2026-09-06T00:00:00.000Z",
          intent: { kind: "setField", fieldId: "name", value: "Briar" },
          attempt: null,
        },
      ],
    });
    const session = makeSession(pending);
    render(<CharacterTools characterId="char-1" api={makeApi()} session={session} />);
    expect(screen.getByRole("button", { name: /^archive$/i })).toBeDisabled();
    expect(session.archive).not.toHaveBeenCalled();
  });

  it("keeps the archive dialog open with an error when the session stops being ready mid-confirm", async () => {
    const user = userEvent.setup();
    let current = readySnapshot();
    const listeners = new Set<(snapshot: CharacterSnapshot) => void>();
    const emit = () => {
      for (const listener of listeners) listener(current);
    };
    const base = makeSession(readySnapshot());
    const session = {
      ...base,
      getSnapshot: () => current,
      subscribe: (listener: (snapshot: CharacterSnapshot) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as Parameters<typeof CharacterTools>[0]["session"];
    render(<CharacterTools characterId="char-1" api={makeApi()} session={session} />);
    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // A queued edit lands after the dialog opened: confirm must not run and
    // must not close the dialog silently.
    current = readySnapshot({
      entries: [
        {
          id: "e1",
          actorId: "a",
          characterId: "char-1",
          sequence: 0,
          baseRevision: 3,
          packageChecksum: "abc",
          createdAt: "2026-09-06T00:00:00.000Z",
          intent: { kind: "setField", fieldId: "name", value: "Briar" },
          attempt: null,
        },
      ],
    });
    emit();
    await user.click(screen.getByRole("button", { name: /confirm archive/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Request failed.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(base.archive).not.toHaveBeenCalled();
  });

  it("restores focus after a secondary dialog closes", async () => {
    const user = userEvent.setup();
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(readySnapshot())} />);
    const activityButton = screen.getByRole("button", { name: /activity/i });
    await user.click(activityButton);
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(activityButton).toHaveFocus();
  });

  it("summarizes candidate values in the migration preview before commit", async () => {
    const user = userEvent.setup();
    const preview = {
      preview: {
        previewId: "p-1",
        characterId: "char-1",
        sourceRevision: 3,
        sourceVersionId: "11111111-1111-4000-8000-000000000000",
        targetVersionId: "22222222-2222-4000-8000-000000000000",
        candidateState: { schemaVersion: "1.0", values: { name: "Aria", health: 5 } },
        candidateProjection: {},
        warnings: [],
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
      requestId: "r",
    } as unknown as MigrationPreviewResponse;
    const api = makeApi({ previewMigration: vi.fn(async () => preview) });
    render(<CharacterTools characterId="char-1" api={api} session={makeSession(readySnapshot())} now={() => "2026-09-06T00:00:00.000Z"} />);
    await user.click(screen.getByRole("button", { name: /migration/i }));
    await user.type(screen.getByLabelText(/target version/i), "22222222-2222-4000-8000-000000000000");
    await user.click(screen.getByRole("button", { name: /preview migration/i }));
    const region = await screen.findByLabelText(/migration preview/i);
    expect(within(region).getByText(/name/)).toBeVisible();
    expect(within(region).getByText(/Aria/)).toBeVisible();
  });

  it("labels the archive cancel button Cancel instead of the title", async () => {
    const user = userEvent.setup();
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(readySnapshot())} />);
    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  it("traps Tab inside secondary dialogs", async () => {
    const user = userEvent.setup();
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(readySnapshot())} />);
    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    const dialog = screen.getByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: /confirm archive/i });
    expect(confirmButton).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab();
    expect(confirmButton).toHaveFocus();
  });

  it("disables commit when the preview source revision drifted and asks for re-preview", async () => {
    const user = userEvent.setup();
    const preview = {
      preview: {
        previewId: "p-1",
        characterId: "char-1",
        sourceRevision: 2,
        sourceVersionId: "11111111-1111-4000-8000-000000000000",
        targetVersionId: "22222222-2222-4000-8000-000000000000",
        candidateState: { schemaVersion: "1.0", values: {} },
        candidateProjection: {},
        warnings: [],
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
      requestId: "r",
    } as unknown as MigrationPreviewResponse;
    const api = makeApi({ previewMigration: vi.fn(async () => preview) });
    const session = makeSession(readySnapshot());
    render(<CharacterTools characterId="char-1" api={api} session={session} now={() => "2026-09-06T00:00:00.000Z"} />);
    await user.click(screen.getByRole("button", { name: /migration/i }));
    await user.type(screen.getByLabelText(/target version/i), "22222222-2222-4000-8000-000000000000");
    await user.click(screen.getByRole("button", { name: /preview migration/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /commit migration/i })).toBeDisabled());
    expect(screen.getByText(/older revision|re-preview/i)).toBeVisible();
    expect(session.commitMigration).not.toHaveBeenCalled();
  });

  it("attaches the export anchor to the document for the click", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    let connectedAtClick: boolean | null = null;
    let clickedAnchor: HTMLAnchorElement | null = null;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      connectedAtClick = this.isConnected;
      clickedAnchor = this;
    });
    render(<CharacterTools characterId="char-1" api={api} session={makeSession(readySnapshot())} />);
    await user.click(screen.getByRole("button", { name: /export/i }));
    await user.click(screen.getByRole("button", { name: /download export/i }));
    await waitFor(() => expect(api.export).toHaveBeenCalledWith("char-1"));
    expect(clickSpy).toHaveBeenCalled();
    expect(connectedAtClick).toBe(true);
    expect(clickedAnchor === null || document.body.contains(clickedAnchor)).toBe(false);
    clickSpy.mockRestore();
  });

  it("loads activity through the session cache and labels rows with kind, summary and time", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const session = makeSession(readySnapshot());
    const fetchActivityPage = vi.fn(async (_cursor: string | null) => ({
      events: [
        { id: "a1", characterRevision: 3, kind: "field-set", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T00:00:00.000Z" },
      ],
      nextCursor: null as string | null,
      stale: false,
      fetchedAt: "2026-09-06T01:00:00.000Z",
    }));
    (session.fetchActivityPage as unknown as typeof fetchActivityPage) = fetchActivityPage;
    render(<CharacterTools characterId="char-1" api={api} session={session} />);
    await user.click(screen.getByRole("button", { name: /activity/i }));
    await waitFor(() => expect(fetchActivityPage).toHaveBeenCalledWith(null));
    expect(api.activity).not.toHaveBeenCalled();
    expect(screen.getByText(/field-set/)).toBeVisible();
    expect(screen.getAllByText(/2026-09-06/).length).toBeGreaterThan(0);
    expect(screen.getByText(/revision 3/i)).toBeVisible();
  });

  it("reopens the last cached activity page marked stale while offline", async () => {
    const user = userEvent.setup();
    const session = makeSession(readySnapshot());
    const cached = {
      events: [
        { id: "a1", characterRevision: 3, kind: "field-set", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T00:00:00.000Z" },
      ],
      nextCursor: null as string | null,
      stale: true,
      fetchedAt: "2026-09-06T01:00:00.000Z",
    };
    (session.fetchActivityPage as unknown as ReturnType<typeof vi.fn>) = vi.fn(async () => cached);
    render(<CharacterTools characterId="char-1" api={makeApi()} session={session} />);
    await user.click(screen.getByRole("button", { name: /activity/i }));
    await waitFor(() => expect(screen.getByText(/field-set/)).toBeVisible());
    expect(screen.getByText(/stale/i)).toBeVisible();
  });

  it("never shows the same activity event twice when cursors overlap", async () => {
    const user = userEvent.setup();
    const session = makeSession(readySnapshot());
    const first = {
      events: [
        { id: "a1", characterRevision: 3, kind: "field-set", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T00:00:00.000Z" },
      ],
      nextCursor: "cursor-1" as string | null,
      stale: false,
      fetchedAt: "2026-09-06T01:00:00.000Z",
    };
    const second = {
      events: [
        { id: "a1", characterRevision: 3, kind: "field-set", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T00:00:00.000Z" },
        { id: "a2", characterRevision: 4, kind: "bump", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T02:00:00.000Z" },
      ],
      nextCursor: null as string | null,
      stale: false,
      fetchedAt: "2026-09-06T03:00:00.000Z",
    };
    const fetchActivityPage = vi.fn(async (cursor: string | null) => (cursor === null ? first : second));
    (session.fetchActivityPage as unknown as typeof fetchActivityPage) = fetchActivityPage;
    render(<CharacterTools characterId="char-1" api={makeApi()} session={session} />);
    await user.click(screen.getByRole("button", { name: /activity/i }));
    await waitFor(() => expect(screen.getByText(/field-set/)).toBeVisible());
    await user.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(fetchActivityPage).toHaveBeenCalledWith("cursor-1"));
    expect(screen.getAllByText(/field-set/)).toHaveLength(1);
    expect(screen.getByText(/bump/)).toBeVisible();
  });

  it("disables migration preview while offline, queued or blocked by an uncertain outcome", async () => {
    const user = userEvent.setup();
    const offline = readySnapshot({ phase: "offline", connected: false });
    const { unmount } = render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(offline)} />);
    await user.click(screen.getByRole("button", { name: /migration/i }));
    expect(screen.getByRole("button", { name: /preview migration/i })).toBeDisabled();
    expect(screen.getByText(/offline|online|connect/i)).toBeVisible();
    unmount();

    const queued = readySnapshot({
      tentative: { name: "Briar" },
      entries: [
        {
          id: "e1",
          actorId: "a",
          characterId: "char-1",
          sequence: 0,
          baseRevision: 3,
          packageChecksum: "abc",
          createdAt: "2026-09-06T00:00:00.000Z",
          intent: { kind: "setField", fieldId: "name", value: "Briar" },
          attempt: null,
        },
      ],
    });
    const second = render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(queued)} />);
    await user.click(second.getByRole("button", { name: /migration/i }));
    expect(second.getByRole("button", { name: /preview migration/i })).toBeDisabled();
    second.unmount();

    const uncertain = readySnapshot({
      pendingOnlineAttempts: [
        {
          id: "online-1",
          actorId: "a",
          characterId: "char-1",
          kind: "archive",
          request: {
            method: "PATCH",
            path: "/characters/char-1",
            body: { command: "archive", expectedRevision: 3, idempotencyKey: "k" },
            firstAttemptAt: "2026-09-06T00:00:00.000Z",
          },
          createdAt: "2026-09-06T00:00:00.000Z",
        },
      ],
    });
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(uncertain)} />);
    await user.click(screen.getByRole("button", { name: /migration/i }));
    expect(screen.getByRole("button", { name: /preview migration/i })).toBeDisabled();
    expect(screen.getByText(/uncertain|earlier.*change|resolve/i)).toBeVisible();
  });

  function migrationPreview(overrides: Record<string, unknown> = {}): MigrationPreviewResponse {
    return {
      preview: {
        previewId: "p-1",
        characterId: "char-1",
        sourceRevision: 3,
        sourceVersionId: "11111111-1111-4000-8000-000000000000",
        targetVersionId: "22222222-2222-4000-8000-000000000000",
        candidateState: { schemaVersion: "1.0", values: { name: "Aria" } },
        candidateProjection: {},
        warnings: [],
        expiresAt: "2027-01-01T00:00:00.000Z",
        ...overrides,
      },
      requestId: "r",
    } as unknown as MigrationPreviewResponse;
  }

  it("requires a renewed confirmation for each fresh migration preview before commit", async () => {
    const user = userEvent.setup();
    const api = makeApi({ previewMigration: vi.fn(async () => migrationPreview()) });
    const session = makeSession(readySnapshot());
    render(<CharacterTools characterId="char-1" api={api} session={session} now={() => "2026-09-06T00:00:00.000Z"} />);
    await user.click(screen.getByRole("button", { name: /migration/i }));
    await user.type(screen.getByLabelText(/target version/i), "22222222-2222-4000-8000-000000000000");
    await user.click(screen.getByRole("button", { name: /preview migration/i }));
    const commit = await screen.findByRole("button", { name: /commit migration/i });
    expect(commit).toBeDisabled();
    await user.click(screen.getByLabelText(/confirm.*commit|reviewed.*preview/i));
    expect(screen.getByRole("button", { name: /commit migration/i })).not.toBeDisabled();
    // A new preview renews the confirmation requirement.
    await user.click(screen.getByRole("button", { name: /preview migration/i }));
    await waitFor(() => expect(api.previewMigration).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /commit migration/i })).toBeDisabled();
  });

  it("exposes the authoritative migration ID for rollback without manual guessing", async () => {
    const user = userEvent.setup();
    const session = makeSession(
      readySnapshot({ lastMigration: { operation: "commit", previewId: "p-1", revision: 5 } }),
    );
    render(<CharacterTools characterId="char-1" api={makeApi()} session={session} now={() => "2026-09-06T00:00:00.000Z"} />);
    await user.click(screen.getByRole("button", { name: /migration/i }));
    expect(screen.getByText(/p-1/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /use last migration|use .*rollback/i }));
    expect(screen.getByLabelText(/migration id/i)).toHaveValue("p-1");
    await user.click(screen.getByRole("button", { name: /roll back migration/i }));
    expect(session.rollbackMigration).toHaveBeenCalledWith("p-1");
  });

  it("blocks export while an uncertain online outcome is pending", async () => {
    const user = userEvent.setup();
    const uncertain = readySnapshot({
      pendingOnlineAttempts: [
        {
          id: "online-1",
          actorId: "a",
          characterId: "char-1",
          kind: "archive",
          request: {
            method: "PATCH",
            path: "/characters/char-1",
            body: { command: "archive", expectedRevision: 3, idempotencyKey: "k" },
            firstAttemptAt: "2026-09-06T00:00:00.000Z",
          },
          createdAt: "2026-09-06T00:00:00.000Z",
        },
      ],
    });
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(uncertain)} />);
    await user.click(screen.getByRole("button", { name: /export/i }));
    expect(screen.getByRole("button", { name: /download export/i })).toBeDisabled();
    expect(screen.getByText(/uncertain|pending.*outcome|resolve/i)).toBeVisible();
  });

  it("blocks export while offline or read-only", async () => {
    const user = userEvent.setup();
    const offline = readySnapshot({ phase: "offline", connected: false });
    const first = render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(offline)} />);
    // Pending local state gates at the button; offline explains itself here.
    expect(first.getByRole("button", { name: /^export$/i })).toBeDisabled();
    first.unmount();
    const readOnly = readySnapshot({ editing: { owned: false, owner: "other-tab" } });
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(readOnly)} />);
    await user.click(screen.getByRole("button", { name: /^export$/i }));
    expect(screen.getByRole("button", { name: /download export/i })).toBeDisabled();
    expect(screen.getByText(/read-only/i)).toBeVisible();
  });

  it("downloads the server document verbatim, never the tentative overlay", async () => {
    const user = userEvent.setup();
    const serverDocument = {
      schemaVersion: "1.0",
      mediaType: "application/vnd.sweetroll.character+json;version=1",
      characterId: "char-1",
      name: "Aria",
      entityDefinitionId: "hero",
      lifecycle: "active",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      systemVersionId: "11111111-1111-4000-8000-000000000000",
      packageChecksum: "abc",
      revision: 3,
      state: { schemaVersion: "1.0", values: { name: "Aria" } },
      migrationLineage: [],
    } as unknown as CharacterExport;
    const api = makeApi({ export: vi.fn(async () => serverDocument) });
    let capturedParts: BlobPart[] | null = null;
    const realBlob = globalThis.Blob;
    (globalThis as unknown as Record<string, unknown>).Blob = function (parts: BlobPart[], options?: BlobPropertyBag) {
      capturedParts = parts;
      return new realBlob(parts, options);
    } as unknown as typeof Blob;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {});
    try {
      render(<CharacterTools characterId="char-1" api={api} session={makeSession(readySnapshot())} />);
      await user.click(screen.getByRole("button", { name: /^export$/i }));
      await user.click(screen.getByRole("button", { name: /download export/i }));
      await waitFor(() => expect(api.export).toHaveBeenCalledWith("char-1"));
      expect(capturedParts).not.toBeNull();
      const parsed = JSON.parse(String(capturedParts![0]));
      expect(parsed).toEqual(JSON.parse(JSON.stringify(serverDocument)));
      expect(parsed.state.values.name).toBe("Aria");
    } finally {
      (globalThis as unknown as Record<string, unknown>).Blob = realBlob;
      clickSpy.mockRestore();
    }
  });

  it("restores focus to the export button after a failed download and cleans up the URL", async () => {
    const user = userEvent.setup();
    const api = makeApi({ export: vi.fn(async () => { throw new Error("boom"); }) });
    render(<CharacterTools characterId="char-1" api={api} session={makeSession(readySnapshot())} />);
    const exportButton = screen.getByRole("button", { name: /^export$/i });
    await user.click(exportButton);
    await user.click(screen.getByRole("button", { name: /download export/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    await user.keyboard("{Escape}");
    expect(exportButton).toHaveFocus();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:export");
  });
});
