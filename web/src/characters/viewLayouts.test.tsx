import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * G3-2 player-sheet layout regression tests.
 *
 * Same jsdom disclosure as the editor suite: jsdom performs no layout, so
 * the "no element wider than viewport" guarantee is asserted against the
 * authored CSS (readable max-widths, min-width:0 chains, wrapping rules).
 * Real-device verification is G9, not claimed here.
 */

function cssOf(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

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

describe("player sheets own readable content widths", () => {
  it("caps the sheet in a centered column instead of full-bleed sprawl", () => {
    const css = cssOf("./characters.module.css");
    expect(ruleBlock(css, ".sheet")).toMatch(/width:\s*min\(100%,\s*720px\)/);
    expect(ruleBlock(css, ".sheet")).toMatch(/margin:\s*0\s*auto/);
    expect(ruleBlock(css, ".sheet")).toMatch(/min-width:\s*0/);
  });

  it("keeps the routed detail and creation views in the same column", () => {
    const css = cssOf("./characters.module.css");
    expect(css).toMatch(/\.detail/);
    expect(css).toMatch(/\.create/);
    expect(ruleBlock(css, ".detail, .create")).toMatch(/width:\s*min\(100%,\s*720px\)/);
    expect(ruleBlock(css, ".detail, .create")).toMatch(/min-width:\s*0/);
  });

  it("lets long values wrap instead of forcing horizontal scroll", () => {
    const css = cssOf("./characters.module.css");
    // Roll-result grid: the value column yields to long mono strings.
    expect(ruleBlock(css, ".rollResult dl")).toMatch(/minmax\(0,\s*1fr\)/);
    expect(ruleBlock(css, ".rollResult dd")).toMatch(/overflow-wrap/);
    // Identity/version metadata (UUIDs) and command errors wrap.
    expect(ruleBlock(css, ".meta, .estimateNote")).toMatch(/overflow-wrap/);
    expect(ruleBlock(css, ".commandError, .fieldError")).toMatch(/overflow-wrap/);
  });

  it("keeps phone padding tight at small widths", () => {
    const css = cssOf("./characters.module.css");
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*420px\s*\)/);
  });
});
