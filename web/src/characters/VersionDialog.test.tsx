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
const X = "33333333-3333-4000-8000-000000000001";
const X1 = "33333333-3333-4000-8000-000000000011";
const X2 = "33333333-3333-4000-8000-000000000012";
const F = "44444444-4444-4000-8000-000000000001";
const F1 = "44444444-4444-4000-8000-000000000011";

function snapshot(overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  return {
    phase: "ready",
    storage: "available", view: { source: "stored" as const, character: makeView({ characterId: "char-1", revision: 3 }) },
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
      current: {
        systemVersion: { versionId: V1, systemId: V1, semanticVersion: "1.0.0", releaseNotes: "", createdAt: "2026-11-01T00:00:00.000Z" },
        extensions: [{
          extensionId: X, name: "Frost pack",
          version: { versionId: X1, systemId: X, semanticVersion: "1.0.0", releaseNotes: "", createdAt: "2026-11-01T00:00:00.000Z" },
          upgrades: [{ versionId: X2, systemId: X, semanticVersion: "1.2.0", releaseNotes: "Colder", createdAt: "2026-11-06T00:00:00.000Z" }],
        }],
      },
      revertTo: null,
      systemUpgrades: [{ versionId: V2, systemId: V1, semanticVersion: "1.1.0", releaseNotes: "New shields", createdAt: "2026-11-05T00:00:00.000Z" }],
      available: [{
        extensionId: F, name: "Fire pack",
        version: { versionId: F1, systemId: F, semanticVersion: "0.9.0", releaseNotes: "", createdAt: "2026-11-02T00:00:00.000Z" },
        upgrades: [],
      }],
    },
    requestId: "r",
  };
  const checked: VersionCheckResponse = { check: { revision: 3, direction: check.direction, change: { kind: "system_upgrade", fromVersionId: V1, toVersionId: V2 }, report: check }, requestId: "r" };
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

    await user.click(screen.getByRole("button", { name: "Rules and extensions" }));
    const dialog = await screen.findByRole("dialog", { name: "Rules and extensions" });
    expect(dialog).toHaveTextContent(/Current rules: 1\.0\.0 .* \+ Frost pack 1\.0\.0/);
    expect(screen.getByRole("radio", { name: /Upgrade Frost pack to 1\.2\.0/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Add Fire pack 0\.9\.0/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Remove Frost pack" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("New shields");
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Upgrade to 1\.1\.0/ }));
    const target = { systemVersionId: V2, extensions: [{ extensionId: X, versionId: X1 }] };
    expect(a.versionCheck).toHaveBeenCalledWith("char-1", target);
    expect(await screen.findByText("Ready: nothing blocks this change.")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("updated to new defaults: weapon_bonus");
    expect(dialog).toHaveTextContent("your values kept: weight");
    expect(dialog).toHaveTextContent("luck");

    await user.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(s.changeVersion).toHaveBeenCalledWith(target);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("explains blockers and keeps the change disabled", async () => {
    const user = userEvent.setup();
    const s = session(snapshot());
    render(<CharacterTools characterId="char-1" api={api(report({ ok: false, blockers: [{ code: "entry_template_missing", message: "Template \"shield\" does not exist in the target version.", entryId: "e2" }] }))} session={s} />);
    await user.click(screen.getByRole("button", { name: "Rules and extensions" }));
    await user.click(await screen.findByRole("radio", { name: /Upgrade to 1\.1\.0/ }));
    expect(await screen.findByText(/Template "shield" does not exist/)).toBeInTheDocument();
    expect(screen.getByText("Blocked: fix the problems below first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeDisabled();
    expect(s.changeVersion).not.toHaveBeenCalled();
  });

  it("is not offered for campaign characters or readers without editing ownership", () => {
    const attached = makeView({ characterId: "char-1", revision: 3, campaignId: "22222222-2222-4000-8000-000000000000" } as Parameters<typeof makeView>[0]);
    const { unmount } = render(<CharacterTools characterId="char-1" api={api(report())} session={session(snapshot({ view: { source: "stored" as const, character: attached } }))} />);
    expect(screen.queryByRole("button", { name: "Rules and extensions" })).not.toBeInTheDocument();
    unmount();
    render(<CharacterTools characterId="char-1" api={api(report())} session={session(snapshot({ editing: { owned: false } }))} />);
    expect(screen.queryByRole("button", { name: "Rules and extensions" })).not.toBeInTheDocument();
  });
});
