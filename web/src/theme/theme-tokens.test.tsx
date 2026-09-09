import * as Dialog from "@radix-ui/react-dialog";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import globalCssRaw from "../styles/global.css?raw";
import { THEME_STORAGE_KEY, applyTheme, persistPreference, resolvePreference } from "./theme.js";

// Vitest runs with the web package directory as cwd.
const INDEX_HTML = join(process.cwd(), "index.html");
const GLOBAL_CSS_PATH = join(process.cwd(), "src/styles/global.css");

// Prefer the file on disk: under vitest the `?raw` CSS import may resolve
// to an empty module, which would silently vacate every text assertion.
function readGlobalCss(): string {
  const fromDisk = readFileSync(GLOBAL_CSS_PATH, "utf8");
  if (fromDisk.trim().length > 0) return fromDisk;
  return globalCssRaw;
}

const globalCss = readGlobalCss();

let styleEl: HTMLStyleElement | null = null;

beforeAll(() => {
  styleEl = document.createElement("style");
  styleEl.setAttribute("data-testid", "g2-theme-test-style");
  styleEl.textContent = globalCss;
  document.head.appendChild(styleEl);
});

afterAll(() => {
  styleEl?.remove();
  styleEl = null;
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  document.documentElement.style.fontSize = "";
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function computedVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Follow var() references until a literal value (jsdom never resolves var()). */
function resolveChain(name: string): string {
  let current = computedVar(name);
  for (let depth = 0; depth < 8; depth++) {
    const match = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(current);
    if (match?.[1] === undefined) return current;
    current = computedVar(match[1]);
  }
  throw new Error(`var() chain did not resolve for ${name}`);
}

describe("token primitives", () => {
  it("keeps every pre-existing primitive name and value", () => {
    expect(computedVar("--color-bg")).toBe("#fafafa");
    expect(computedVar("--color-surface")).toBe("#ffffff");
    expect(computedVar("--color-fg")).toBe("#171717");
    expect(computedVar("--color-fg-muted")).toBe("#525252");
    expect(computedVar("--color-border")).toBe("#e5e5e5");
    expect(computedVar("--color-accent")).toBe("#4f46e5");
    expect(computedVar("--color-accent-fg")).toBe("#ffffff");
    expect(computedVar("--color-error")).toBe("#dc2626");
    expect(computedVar("--color-warning")).toBe("#d97706");
    expect(computedVar("--color-warning-fg")).toBe("#92400e");
    expect(computedVar("--color-success")).toBe("#059669");
    expect(computedVar("--font-sans")).toContain("system-ui");
    expect(computedVar("--font-mono")).toContain("Menlo");
    expect(computedVar("--radius-sm")).toBe("4px");
    expect(computedVar("--radius-md")).toBe("6px");
    expect(computedVar("--radius-lg")).toBe("8px");
    expect(computedVar("--radius-xl")).toBe("12px");
  });
});

describe("semantic aliases (light)", () => {
  it("aliases resolve through primitives to the current values", () => {
    expect(resolveChain("--surface-page")).toBe("#fafafa");
    expect(resolveChain("--surface-panel")).toBe("#ffffff");
    expect(resolveChain("--text-primary")).toBe("#171717");
    expect(resolveChain("--text-muted")).toBe("#525252");
    expect(resolveChain("--border-default")).toBe("#e5e5e5");
    expect(resolveChain("--action-primary")).toBe("#4f46e5");
    expect(resolveChain("--action-primary-fg")).toBe("#ffffff");
    expect(resolveChain("--action-danger")).toBe("#dc2626");
    expect(resolveChain("--action-danger-fg")).toBe("#ffffff");
    expect(resolveChain("--status-error")).toBe("#dc2626");
    expect(resolveChain("--status-warning")).toBe("#d97706");
    expect(resolveChain("--status-warning-fg")).toBe("#92400e");
    expect(resolveChain("--status-success")).toBe("#059669");
    expect(resolveChain("--font-body")).toContain("system-ui");
    expect(resolveChain("--font-code")).toContain("Menlo");
    expect(resolveChain("--radius-control")).toBe("4px");
    expect(resolveChain("--radius-panel")).toBe("6px");
    expect(resolveChain("--radius-dialog")).toBe("8px");
    expect(computedVar("--radius-pill")).toBe("999px");
    expect(computedVar("--layer-dialog-overlay")).toBe("1000");
    expect(computedVar("--layer-dialog-content")).toBe("1001");
  });

  it("migrated badge/overlay/shadow literals resolve to the values they replaced", () => {
    // VersionHistory badgeActive was color #166534 on rgba(34,197,94,…).
    expect(resolveChain("--status-success-fg")).toBe("#166534");
    expect(resolveChain("--status-success-bg")).toBe("rgba(34, 197, 94, 0.12)");
    expect(resolveChain("--status-success-border")).toBe("rgba(34, 197, 94, 0.4)");
    // Dialog overlays were rgba(23,23,23,0.45); dialog shadow the matching blur.
    expect(resolveChain("--surface-scrim")).toBe("rgba(23, 23, 23, 0.45)");
    expect(computedVar("--shadow-dialog")).toBe("0 12px 32px var(--color-shadow)");
    expect(resolveChain("--surface-hover")).toBe("rgba(0, 0, 0, 0.05)");
    expect(computedVar("--focus-ring")).toBe("2px solid var(--color-accent)");
  });
});

describe("dark preset", () => {
  it("re-resolves aliases through overridden primitives, staying neutral", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    expect(resolveChain("--surface-page")).toBe("#171717");
    expect(resolveChain("--surface-panel")).toBe("#262626");
    expect(resolveChain("--text-primary")).toBe("#fafafa");
    expect(resolveChain("--action-primary")).toBe("#818cf8");
    expect(resolveChain("--status-error")).toBe("#f87171");
    expect(resolveChain("--status-success")).toBe("#34d399");
  });

  it("is documented as a neutral placeholder, not Tablefolk styling", () => {
    expect(globalCss).toContain("pending mockup reference");
    expect(globalCss).not.toContain("Tablefolk green");
  });
});

describe("third internal preset", () => {
  it("changes accent, font stack, and radii via token overrides only", () => {
    document.documentElement.setAttribute("data-theme", "contrast");
    expect(resolveChain("--action-primary")).toBe("#1e40af");
    expect(resolveChain("--font-body")).toContain("Verdana");
    expect(resolveChain("--radius-panel")).toBe("0");
    expect(resolveChain("--radius-control")).toBe("0");
    expect(resolveChain("--radius-dialog")).toBe("0");
  });
});

describe("portal inheritance", () => {
  it("portaled Radix dialog content inherits documentElement tokens", async () => {
    applyTheme("dark");
    render(
      <Dialog.Root defaultOpen>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content data-testid="theme-portal-probe">
            <p>portal body</p>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    );
    const probe = await screen.findByTestId("theme-portal-probe");
    // Portals attach to document.body, outside any React root subtree, so
    // the only theming path is inheritance from documentElement.
    expect(probe.ownerDocument).toBe(document);
    expect(document.body.contains(probe)).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(computedVar("--surface-panel")).not.toBe("");
    expect(resolveChain("--surface-panel")).toBe("#262626");
    // Tokens must be scoped to :root/[data-theme], never to an app subtree
    // that portals escape.
    expect(globalCss).toMatch(/:root\s*\{[^}]*--surface-page/);
  });
});

describe("theme switching preserves state", () => {
  function CharacterProbe() {
    const [name, setName] = useState("Ash");
    const [hp, setHp] = useState(7);
    const [mounts] = useState(() => ({ count: 1 }));
    return (
      <section>
        <label>
          name
          <input aria-label="name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="button" onClick={() => setHp((v) => v + 1)}>
          hp {hp}
        </button>
        <span data-testid="mount-count">{mounts.count}</span>
      </section>
    );
  }

  it("switching light/dark/system keeps a mounted editor/character probe intact", async () => {
    const user = userEvent.setup();
    render(<CharacterProbe />);
    const nameInput = screen.getByLabelText("name") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Ash Ketchum");
    await user.click(screen.getByRole("button", { name: /hp 7/ }));
    const inputNode = nameInput;

    persistPreference("dark");
    persistPreference("light");
    persistPreference("system");

    expect(document.body.contains(inputNode)).toBe(true);
    expect(screen.getByLabelText("name")).toBe(inputNode);
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("Ash Ketchum");
    expect(screen.getByRole("button", { name: /hp 8/ })).toBeInTheDocument();
    expect(screen.getByTestId("mount-count")).toHaveTextContent("1");
  });
});

describe("reduced motion", () => {
  it("ships a global prefers-reduced-motion rule", () => {
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)");
    const block = globalCss.slice(globalCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("animation-duration");
    expect(block).toContain("transition-duration");
  });
});

describe("touch targets and text enlargement", () => {
  it("enforces a 44x44px floor on button-ish controls", () => {
    render(<button type="button">save</button>);
    const button = screen.getByRole("button", { name: "save" });
    const style = getComputedStyle(button);
    expect(style.minHeight).toBe("44px");
    expect(style.minWidth).toBe("44px");
  });

  it("keeps long labels usable at 200% font size without truncation styling", async () => {
    document.documentElement.style.fontSize = "200%";
    const user = userEvent.setup();
    const onClick = vi.fn();
    const longLabel =
      "Replace server version with my local changes, keeping every field I edited offline";
    render(
      <div style={{ width: "200px" }}>
        <button type="button" onClick={onClick}>
          {longLabel}
        </button>
      </div>,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent(longLabel);
    expect(getComputedStyle(button).textOverflow).not.toBe("ellipsis");
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).toBeEnabled();
  });
});

describe("before-paint script", () => {
  function readInlineScript(): string {
    const html = readFileSync(INDEX_HTML, "utf8");
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (match) => match[1] ?? "",
    );
    expect(scripts.length).toBeGreaterThan(0);
    return scripts.join("\n");
  }

  function stubDevice(matches: boolean) {
    const listeners: Array<(event: { matches: boolean }) => void> = [];
    const media = {
      matches,
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
        listeners.push(listener);
      },
      addListener: (listener: (event: { matches: boolean }) => void) => {
        listeners.push(listener);
      },
    };
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    return { media, listeners };
  }

  function runBeforePaint(): void {
    const code = readInlineScript();
    new Function(code)();
  }

  it("is inline, CSP-safe, and reads the persisted device preference", () => {
    const html = readFileSync(INDEX_HTML, "utf8");
    expect(html).not.toMatch(/<script[^>]*\bsrc="https?:/);
    const code = readInlineScript();
    expect(code).toContain(THEME_STORAGE_KEY);
    expect(code).toContain("data-theme");
    expect(code).toContain("prefers-color-scheme");
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toContain("document.write");
  });

  it("applies the stored explicit preference before paint", () => {
    stubDevice(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    runBeforePaint();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    runBeforePaint();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("follows the device when nothing valid is stored", () => {
    stubDevice(true);
    runBeforePaint();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    stubDevice(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "nonsense");
    runBeforePaint();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("stays in sync with later OS changes while following the device", () => {
    const { listeners } = stubDevice(false);
    runBeforePaint();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(listeners.length).toBeGreaterThan(0);
    for (const listener of listeners) listener({ matches: true });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("does not follow OS changes for an explicit preference", () => {
    const { listeners } = stubDevice(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    runBeforePaint();
    expect(listeners.length).toBe(0);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("matches the theme.ts resolution for the preference matrix", () => {
    const cases: Array<{ stored: string | null; matchesDark: boolean }> = [
      { stored: "light", matchesDark: true },
      { stored: "light", matchesDark: false },
      { stored: "dark", matchesDark: true },
      { stored: "dark", matchesDark: false },
      { stored: "system", matchesDark: true },
      { stored: "system", matchesDark: false },
      { stored: null, matchesDark: true },
      { stored: null, matchesDark: false },
      { stored: "nonsense", matchesDark: true },
    ];
    for (const { stored, matchesDark } of cases) {
      window.localStorage.clear();
      if (stored !== null) window.localStorage.setItem(THEME_STORAGE_KEY, stored);
      stubDevice(matchesDark);
      runBeforePaint();
      const expected = resolvePreference(
        stored === "light" || stored === "dark" || stored === "system" ? stored : "system",
        matchesDark,
      );
      expect(document.documentElement.getAttribute("data-theme")).toBe(expected);
    }
  });
});
