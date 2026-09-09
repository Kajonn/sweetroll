import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import { blankDocument } from "../state/documentReducer.js";
import { ConflictBanner } from "./ConflictBanner.js";
import { DocumentEditor } from "./DocumentEditor.js";
import editorStyles from "./DocumentEditor.module.css";

/**
 * G3-2 view-owned layout regression tests.
 *
 * jsdom performs no layout: every scrollWidth/clientWidth reads 0, so no
 * jsdom test can observe a real 605px-in-360px overflow (the G0 conflict
 * banner defect). The overflow guarantee here is therefore asserted against
 * the authored CSS — the min-width:0 / wrapping / breakpoint rules that a
 * layout engine needs — plus structural checks that the banner flow keeps
 * its recovery controls. Real-device verification is G9, not claimed here.
 */

function cssOf(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** Extract the declaration block for a top-level selector. */
function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

function renderBannerInEditorPane() {
  return render(
    <section className={editorStyles.container}>
      <ConflictBanner
        latestRevision={3}
        onAcceptTheirs={() => {}}
        onKeepMine={() => {}}
        onDismiss={() => {}}
      />
    </section>,
  );
}

describe("conflict-banner editor flow (G0 defect regression)", () => {
  it("keeps both recovery actions and dismiss reachable", () => {
    renderBannerInEditorPane();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload theirs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /replace server version/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });

  it("declares no fixed inline widths in the banner flow", () => {
    // Guards the shape jsdom CAN see: no element pins itself wider than a
    // 320px phone via inline style. Stylesheet rules are covered below.
    const { container } = renderBannerInEditorPane();
    const offenders: string[] = [];
    for (const el of container.querySelectorAll<HTMLElement>("*")) {
      const width = Number.parseFloat(el.style.width);
      if (Number.isFinite(width) && width > 320) offenders.push(el.tagName);
    }
    expect(offenders).toEqual([]);
  });

  it("authors the overflow chain that caused the 605px-in-360px defect", () => {
    const banner = cssOf("./ConflictBanner.module.css");
    const editor = cssOf("./DocumentEditor.module.css");
    // Banner must be able to shrink inside the editor pane grid …
    expect(ruleBlock(banner, ".banner")).toMatch(/min-width:\s*0/);
    expect(ruleBlock(banner, ".banner")).toMatch(/max-width:\s*100%/);
    expect(ruleBlock(banner, ".banner")).toMatch(/minmax\(0,\s*1fr\)/);
    // … its message and buttons must wrap instead of forcing width …
    expect(ruleBlock(banner, ".message")).toMatch(/overflow-wrap/);
    expect(ruleBlock(banner, ".actions")).toMatch(/flex-wrap:\s*wrap/);
    // … and the editor pane itself must not impose a minimum width.
    expect(ruleBlock(editor, ".container")).toMatch(/min-width:\s*0/);
    expect(ruleBlock(editor, ".container")).toMatch(/max-width:\s*100%/);
  });
});

describe("creator pages own their editor/preview columns", () => {
  it("stacks below desktop and splits side-by-side at desktop widths", () => {
    const editor = cssOf("./DocumentEditor.module.css");
    // Design 10.1 desktop boundary: >=1024px multi-panel.
    expect(editor).toMatch(/@media\s*\(\s*min-width:\s*1024px\s*\)/);
    expect(ruleBlock(editor, ".bodySplit")).toMatch(/min-width:\s*0/);
    const desktop = editor.slice(editor.indexOf("@media (min-width: 1024px)"));
    expect(desktop).toMatch(/\.bodySplit/);
    expect(desktop).toMatch(/minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)/);
    // Design 10.1 phone boundary: 320-599px single column, tighter gutters.
    expect(editor).toMatch(/@media\s*\(\s*max-width:\s*599px\s*\)/);
    // The header never forces a row wider than the viewport.
    expect(ruleBlock(editor, ".header")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("applies the split class only while the preview pane is visible", async () => {
    const user = userEvent.setup();
    const doc = {
      ...blankDocument(),
      entities: [{ id: "e1", label: "Entity", fields: [] }],
    };
    const fetch_ = vi.fn(async (input: RequestInfo | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes("/versions")) {
        return new Response(JSON.stringify({ versions: [], requestId: "r" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          workspace: {
            system: {
              systemId: "s1",
              name: "Layout System",
              access: "private",
              lifecycle: "active",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
            draft: {
              revision: 1,
              document: doc,
              sourceChecksum: "c",
              updatedBy: "u",
              updatedAt: "2026-01-01T00:00:00Z",
            },
            versions: [],
            assessment: { ok: true, diagnostics: [] },
          },
          requestId: "r",
        }),
        { status: 200 },
      );
    });
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DocumentEditor client={client} systemId="s1" />
      </QueryClientProvider>,
    );
    const toggle = await screen.findByTestId("document-editor-preview-toggle");
    const body = await screen.findByTestId("document-editor-body-metadata");
    const bodyClass = editorStyles.body as string;
    const splitClass = editorStyles.bodySplit as string;
    expect(body.classList.contains(splitClass)).toBe(false);
    await user.click(toggle);
    expect(await screen.findByTestId("document-editor-preview")).toBeInTheDocument();
    expect(body.classList.contains(bodyClass)).toBe(true);
    expect(body.classList.contains(splitClass)).toBe(true);
    await user.click(toggle);
    expect(screen.queryByTestId("document-editor-preview")).not.toBeInTheDocument();
    expect(body.classList.contains(splitClass)).toBe(false);
  });

  it("collapses fixed two-column editors before phone widths", () => {
    const entities = cssOf("./EntityList.module.css");
    // 280px sidebar + detail cannot fit a 320-599px phone: single column.
    expect(entities).toMatch(/@media\s*\(\s*max-width:\s*720px\s*\)/);
    const narrow = entities.slice(entities.indexOf("@media (max-width: 720px)"));
    expect(narrow).toMatch(/\.layout/);
    expect(narrow).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    // Flex field minimums yield instead of forcing overflow.
    expect(ruleBlock(entities, ".labelField")).toMatch(/min-width:\s*0/);
    const sheets = cssOf("./sheet/SheetEditor.module.css");
    for (const selector of [".headerLabel", ".sectionLabel", ".elementField"]) {
      expect(ruleBlock(sheets, selector)).toMatch(/min-width:\s*0/);
    }
    const rolls = cssOf("./actions/RollActionEditor.module.css");
    expect(ruleBlock(rolls, ".field")).toMatch(/min-width:\s*0/);
    const fields = cssOf("./fields/FieldEditor.module.css");
    expect(ruleBlock(fields, ".optionsRow > input[type=\"text\"]")).toMatch(/min-width:\s*0/);
  });
});

describe("creator-adjacent views stay within the viewport", () => {
  it("restacks the version-history table on phones", () => {
    const history = cssOf("../publish/VersionHistory.module.css");
    expect(ruleBlock(history, ".root")).toMatch(/min-width:\s*0/);
    expect(history).toMatch(/@media\s*\(\s*max-width:\s*599px\s*\)/);
    const phone = history.slice(history.indexOf("@media (max-width: 599px)"));
    expect(phone).toMatch(/\.table/);
    expect(phone).toMatch(/display:\s*block/);
  });

  it("keeps publish dialogs and the library list wrappable", () => {
    const publish = cssOf("../publish/PublishDialog.module.css");
    expect(ruleBlock(publish, ".metaRow")).toMatch(/minmax\(0,\s*1fr\)/);
    expect(ruleBlock(publish, ".actions")).toMatch(/flex-wrap:\s*wrap/);
    const library = cssOf("../library/SystemLibrary.module.css");
    expect(ruleBlock(library, ".container")).toMatch(/min-width:\s*0/);
    expect(ruleBlock(library, ".list li")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("scrolls the exact-width preview canvas inside its viewport", () => {
    const frame = cssOf("../preview/PreviewFrame.module.css");
    expect(ruleBlock(frame, ".viewport")).toMatch(/width:\s*100%/);
    expect(ruleBlock(frame, ".viewport")).toMatch(/max-width:\s*100%/);
    expect(ruleBlock(frame, ".viewport")).toMatch(/min-width:\s*0/);
    expect(ruleBlock(frame, ".viewport")).toMatch(/overflow-x:\s*auto/);
    expect(ruleBlock(frame, ".container")).not.toMatch(/max-width:\s*100%/);
  });
});
