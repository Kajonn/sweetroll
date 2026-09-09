import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, test } from "vitest";

import type { CharactersApi } from "./api.js";
import { CharacterTools } from "./CharacterTools.js";
import type { CharacterSession, CharacterSnapshot } from "./session.js";
import { makeView } from "./testing.js";

function readCssModule(file: string): string {
  return readFileSync(join(process.cwd(), "src/characters", file), "utf8");
}

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
  return {
    open: vi.fn(async () => {}),
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
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

function makeApi(): CharactersApi {
  return {
    open: vi.fn(async () => ({ character: makeView({ characterId: "char-1", revision: 3 }), requestId: "r" })),
    creationOptions: vi.fn(async () => {
      throw new Error("unused");
    }),
    activity: vi.fn(async () => ({ events: [], nextCursor: null, requestId: "r" })),
    send: vi.fn(async () => {
      throw new Error("unused");
    }),
    export: vi.fn(async () => {
      throw new Error("unused");
    }),
    previewMigration: vi.fn(async () => {
      throw new Error("unused");
    }),
  } as unknown as CharactersApi;
}

test("character controls consume only semantic tokens", () => {
  const src = readCssModule("characters.module.css"); // helper: fs read of the module source
  expect(src).not.toMatch(/var\(--color-/);
});

describe("g4 character surface restyle", () => {
  it("character surfaces meet the 44px touch target and reuse :focus-visible plus semantic aliases", () => {
    const css = readCssModule("characters.module.css");
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toMatch(/min-width:\s*44px/);
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/var\(--focus-ring\)/);
    expect(css).toMatch(/var\(--surface-panel\)/);
    expect(css).toMatch(/var\(--text-muted\)/);
    expect(css).toMatch(/var\(--action-primary\)/);
    expect(css).toMatch(/var\(--border-default\)/);
    expect(css).toMatch(/var\(--status-error\)/);
    expect(css).toMatch(/var\(--radius-panel\)/);
    expect(css).not.toMatch(/var\(--color-/);
    expect(css).toMatch(/prefers-reduced-motion/);
  });

  it("tool dialog buttons keep dialogTrap roles (no Radix swap)", async () => {
    const user = userEvent.setup();
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(readySnapshot())} />); // open ActivityDialog
    await user.click(screen.getByRole("button", { name: /activity/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument(); // custom trap root, not Radix
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("keeps launcher and dialog button accessible names and dialog roles", async () => {
    const user = userEvent.setup();
    render(<CharacterTools characterId="char-1" api={makeApi()} session={makeSession(readySnapshot())} />);
    for (const name of [/^activity$/i, /^archive$/i, /^recover$/i, /^export$/i, /migration/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
