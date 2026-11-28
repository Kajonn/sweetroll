import { describe, expect, it } from "vitest";

import { grantsScope } from "./personal-tokens.js";

describe("grantsScope", () => {
  it("lets a write scope include read for the same area only", () => {
    expect(grantsScope(["characters:write"], "characters:read")).toBe(true);
    expect(grantsScope(["characters:write"], "characters:write")).toBe(true);
    expect(grantsScope(["characters:write"], "campaigns:read")).toBe(false);
    expect(grantsScope(["campaigns:write"], "characters:read")).toBe(false);
  });

  it("never lets read imply write", () => {
    expect(grantsScope(["characters:read"], "characters:write")).toBe(false);
    expect(grantsScope(["systems:read", "campaigns:read"], "systems:write")).toBe(false);
  });
});
