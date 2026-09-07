import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { CharacterTools } from "./CharacterTools.js";
import type { CharactersApi } from "./api.js";
import type { CharacterSession, CharacterSnapshot } from "./session.js";
import { makeView } from "./testing.js";
import type { ActivityResponse, CharacterExport, MigrationPreviewResponse } from "./types.js";

function readySnapshot(overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  return {
    phase: "ready",
    confirmed: makeView({ characterId: "char-1", revision: 3 }),
    tentative: null,
    entries: [],
    editing: { owned: true },
    error: null,
    lastRoll: null,
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

  it("pages activity with a cursor and keeps the last page offline labeled stale", async () => {
    const user = userEvent.setup();
    const page1: ActivityResponse = {
      events: [{ id: "a1", characterRevision: 3, kind: "set", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T00:00:00.000Z" }],
      nextCursor: "cursor-1",
      requestId: "r",
    };
    const page2: ActivityResponse = {
      events: [{ id: "a2", characterRevision: 4, kind: "bump", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T00:00:00.000Z" }],
      nextCursor: null,
      requestId: "r",
    };
    const activity = vi.fn(async (_id: string, cursor: string | null) => (cursor === null ? page1 : page2));
    const api = makeApi({ activity: activity as CharactersApi["activity"] });
    render(<CharacterTools characterId="char-1" api={api} session={makeSession(readySnapshot())} />);
    await user.click(screen.getByRole("button", { name: /activity/i }));
    await waitFor(() => expect(screen.getByText(/a1/)).toBeVisible());
    await user.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getByText(/a2/)).toBeVisible());
    expect(activity).toHaveBeenLastCalledWith("char-1", "cursor-1");
    activity.mockRejectedValueOnce(new TypeError("offline"));
    await user.click(screen.getByRole("button", { name: /refresh activity/i }));
    await waitFor(() => expect(screen.getAllByText(/stale|offline/i).length).toBeGreaterThan(0));
    expect(screen.getByText(/a2/)).toBeVisible();
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
});
