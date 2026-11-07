import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CharacterTools } from "./CharacterTools.js";
import type { CharactersApi } from "./api.js";
import type { CharacterSession, CharacterSnapshot } from "./session.js";
import { makeView } from "./testing.js";
import type { VersionChangeReport, VersionCheckResponse, VersionOptionsResponse } from "./types.js";

const V1 = "11111111-1111-4000-8000-000000000001";
const V2 = "11111111-1111-4000-8000-000000000002";

function snapshot(overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
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

function session(snap: CharacterSnapshot) {
  return {
    open: vi.fn(async () => {}),
    getSnapshot: () => snap,
    subscribe: () => () => {},
    changeVersion: vi.fn(async () => {}),
  } as unknown as CharacterSession & { changeVersion: ReturnType<typeof vi.fn> };
}

function report(overrides: Partial<VersionChangeReport> = {}): VersionChangeReport {
  return {
    ok: true, direction: "upgrade", fromVersionId: V1, toVersionId: V2,
    packageFindings: [], blockers: [], addedFields: ["luck"], droppedFields: [],
    changedEntries: [{ entryId: "e1", templateId: "longsword", updatedFields: ["weapon_bonus"], keptFields: ["weight"], addedFields: [], droppedFields: [], imageUpdated: false }],
    validations: [],
    ...overrides,
  };
}

function api(check: VersionChangeReport): CharactersApi {
  const options: VersionOptionsResponse = {
    options: {
      current: { versionId: V1, systemId: V1, semanticVersion: "1.0.0", releaseNotes: "", createdAt: "2026-11-01T00:00:00.000Z" },
      revertTo: null,
      upgrades: [{ versionId: V2, systemId: V1, semanticVersion: "1.1.0", releaseNotes: "New shields", createdAt: "2026-11-05T00:00:00.000Z" }],
    },
    requestId: "r",
  };
  const checked: VersionCheckResponse = { check: { revision: 3, direction: check.direction, report: check }, requestId: "r" };
  return {
    versionOptions: vi.fn(async () => options),
    versionCheck: vi.fn(async () => checked),
  } as unknown as CharactersApi;
}

describe("character rules version", () => {
  it("checks a later version, shows the preview and upgrades through the session", async () => {
    const user = userEvent.setup();
    const s = session(snapshot());
    const a = api(report());
    render(<CharacterTools characterId="char-1" api={a} session={s} />);

    await user.click(screen.getByRole("button", { name: "Rules version" }));
    const dialog = await screen.findByRole("dialog", { name: "Rules version" });
    expect(dialog).toHaveTextContent("Current version: 1.0.0");
    expect(dialog).toHaveTextContent("New shields");
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Upgrade to 1\.1\.0/ }));
    expect(a.versionCheck).toHaveBeenCalledWith("char-1", V2);
    expect(await screen.findByText("Ready: nothing blocks this change.")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("updated to new defaults: weapon_bonus");
    expect(dialog).toHaveTextContent("your values kept: weight");
    expect(dialog).toHaveTextContent("luck");

    await user.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(s.changeVersion).toHaveBeenCalledWith(V2);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("explains blockers and keeps the change disabled", async () => {
    const user = userEvent.setup();
    const s = session(snapshot());
    render(<CharacterTools characterId="char-1" api={api(report({ ok: false, blockers: [{ code: "entry_template_missing", message: "Template \"shield\" does not exist in the target version.", entryId: "e2" }] }))} session={s} />);
    await user.click(screen.getByRole("button", { name: "Rules version" }));
    await user.click(await screen.findByRole("radio", { name: /Upgrade to 1\.1\.0/ }));
    expect(await screen.findByText(/Template "shield" does not exist/)).toBeInTheDocument();
    expect(screen.getByText("Blocked: fix the problems below first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeDisabled();
    expect(s.changeVersion).not.toHaveBeenCalled();
  });

  it("is not offered for campaign characters or readers without editing ownership", () => {
    const attached = makeView({ characterId: "char-1", revision: 3, campaignId: "22222222-2222-4000-8000-000000000000" } as Parameters<typeof makeView>[0]);
    const { unmount } = render(<CharacterTools characterId="char-1" api={api(report())} session={session(snapshot({ confirmed: attached }))} />);
    expect(screen.queryByRole("button", { name: "Rules version" })).not.toBeInTheDocument();
    unmount();
    render(<CharacterTools characterId="char-1" api={api(report())} session={session(snapshot({ editing: { owned: false } }))} />);
    expect(screen.queryByRole("button", { name: "Rules version" })).not.toBeInTheDocument();
  });
});
