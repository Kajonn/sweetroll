import { act, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { CharacterTools } from "./CharacterTools.js";
import type { CharactersApi } from "./api.js";
import type { CharacterSession, CharacterSnapshot } from "./session.js";
import { makeView } from "./testing.js";
import type { CharacterExport } from "./types.js";

function readySnapshot(overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  return {
    phase: "ready",
    confirmed: makeView({ characterId: "char-1", revision: 3 }),
    tentative: null,
    entries: [],
    editing: { owned: true },
    error: null,
    lastRoll: null, lastNominal: null,
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
    listCreationVersions: vi.fn(async () => ({ data: { versions: [], nextCursor: null }, requestId: "r" })),
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
    })),
    ...overrides,
  } as unknown as CharactersApi;
}

describe("CharacterTools", () => {
  it("does not offer character version migration or rollback", () => {
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(readySnapshot())} />);
    expect(screen.queryByRole("button", { name: /migration|rollback|upgrade/i })).not.toBeInTheDocument();
  });

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
    await waitFor(() => expect(screen.getByText(/Field set/)).toBeVisible());
    await user.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getByText(/Bump/)).toBeVisible());
    expect(fetchActivityPage).toHaveBeenLastCalledWith("cursor-1");
    expect(api.activity).not.toHaveBeenCalled();
    // Close, go offline, reopen: the last fetched page shows marked stale.
    await user.click(screen.getByRole("button", { name: /^close$/i }));
    fetchActivityPage.mockImplementation(async () => ({ ...second, stale: true }));
    await user.click(screen.getByRole("button", { name: /activity/i }));
    await waitFor(() => expect(screen.getByText(/Bump/)).toBeVisible());
    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0);
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

  it("loads activity through the session cache and shows a readable action and local date", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const session = makeSession(readySnapshot());
    const fetchActivityPage = vi.fn(async (_cursor: string | null) => ({
      events: [
        { id: "a1", characterRevision: 3, kind: "character_field_set", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T00:00:00.000Z" },
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
    expect(screen.getByText("Field updated")).toBeVisible();
    expect(screen.getByText("Field updated").closest("li")?.querySelector("time")).toHaveAttribute("dateTime", "2026-09-06T00:00:00.000Z");
    expect(screen.queryByText(/revision 3/i)).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText(/Field set/)).toBeVisible());
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
    await waitFor(() => expect(screen.getByText(/Field set/)).toBeVisible());
    await user.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(fetchActivityPage).toHaveBeenCalledWith("cursor-1"));
    expect(screen.getAllByText(/Field set/)).toHaveLength(1);
    expect(screen.getByText(/Bump/)).toBeVisible();
  });

  it("offers readable recovery when an Activity response loses its cache generation", async () => {
    const user = userEvent.setup();
    const session = makeSession(readySnapshot());
    session.fetchActivityPage = vi.fn()
      .mockRejectedValueOnce(new Error("stale activity save: character generation changed"))
      .mockResolvedValueOnce({ events: [], nextCursor: null, stale: false, fetchedAt: "2026-10-25T00:00:00Z" });
    render(<CharacterTools characterId="char-1" api={makeApi()} session={session} />);
    await user.click(screen.getByRole("button", { name: /^Activity$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Activity changed while loading. Refresh activity to try again.");
    expect(screen.queryByText(/stale activity save/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /refresh activity/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(session.fetchActivityPage).toHaveBeenCalledTimes(2);
  });

  it("starts Activity once after opening settles, including a StrictMode effect restart", async () => {
    const user = userEvent.setup();
    const session = makeSession(readySnapshot());
    let finish!: () => void;
    const opening = new Promise<void>(resolve => { finish = resolve; });
    session.open = vi.fn(() => opening);
    render(<StrictMode><CharacterTools characterId="char-1" api={makeApi()} session={session} /></StrictMode>);
    await user.click(screen.getByRole("button", { name: /^Activity$/ }));
    expect(screen.getByRole("button", { name: /refresh activity/i })).toBeDisabled();
    expect(session.fetchActivityPage).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole("button", { name: /refresh activity/i })).toBeEnabled());
    expect(session.fetchActivityPage).toHaveBeenCalledTimes(1);
  });

  it("cancels the deferred Activity read when the dialog closes before opening settles", async () => {
    const user = userEvent.setup();
    const session = makeSession(readySnapshot());
    let finish!: () => void;
    const opening = new Promise<void>(resolve => { finish = resolve; });
    session.open = vi.fn(() => opening);
    render(<StrictMode><CharacterTools characterId="char-1" api={makeApi()} session={session} /></StrictMode>);
    await user.click(screen.getByRole("button", { name: /^Activity$/ }));
    await user.click(screen.getByRole("button", { name: /^Close$/ }));
    await act(async () => finish());
    expect(screen.queryByRole("dialog", { name: /^Activity$/ })).not.toBeInTheDocument();
    expect(session.fetchActivityPage).not.toHaveBeenCalled();
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

it("keeps activity keyboard focus on an enabled control during its initial load",async()=>{
 const user=userEvent.setup();const session=makeSession(readySnapshot());
 let finish!:(value:Awaited<ReturnType<CharacterSession["fetchActivityPage"]>>)=>void;
 session.fetchActivityPage=vi.fn(()=>new Promise<Awaited<ReturnType<CharacterSession["fetchActivityPage"]>>>(resolve=>{finish=resolve;}));
 render(<CharacterTools characterId="char-1" api={makeApi()} session={session}/>);
 await user.click(screen.getByRole("button",{name:"Activity"}));
 expect(screen.getByRole("button",{name:"Refresh activity"})).toBeDisabled();
 expect(screen.getByRole("button",{name:"Close"})).toHaveFocus();
 finish({events:[],nextCursor:null,stale:false,fetchedAt:"2026-10-23T00:00:00.000Z"});
 await waitFor(()=>expect(screen.getByRole("button",{name:"Refresh activity"})).toBeEnabled());
 await user.keyboard("{Escape}");expect(screen.queryByRole("dialog",{name:"Activity"})).toBeNull();
 expect(screen.getByRole("button",{name:"Activity"})).toHaveFocus();
});
