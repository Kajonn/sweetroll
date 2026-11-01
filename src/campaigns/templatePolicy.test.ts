import { describe, expect, it } from "vitest";
import {
  canReadTemplate,
  canPlaceTemplate,
  templateReadScope,
} from "./templatePolicy.js";
import type { MembershipRecord } from "./persistence.js";
const member = {
  userId: "player",
  role: "player",
  status: "active",
  generation: 2,
} as MembershipRecord;
describe("restricted template policy", () => {
  it("requires a current generation grant for selected drafts", () => {
    const t = {
      audience: "selected_players" as const,
      status: "active",
      grants: [{ userId: "player", generation: 1 }],
    };
    expect(canReadTemplate(t, member)).toBe(false);
    expect(
      canReadTemplate(
        { ...t, grants: [{ userId: "player", generation: 2 }] },
        member,
      ),
    ).toBe(true);
  });
  it("hides secret and archived templates from players and removed managers", () => {
    const t = { audience: "gm_only" as const, status: "active", grants: [] };
    expect(canReadTemplate(t, member)).toBe(false);
    expect(
      canReadTemplate(
        { ...t, audience: "all_players", status: "archived" },
        member,
      ),
    ).toBe(false);
    expect(canReadTemplate(t, { ...member, role: "owner" })).toBe(true);
    expect(
      canReadTemplate(t, { ...member, role: "owner", status: "removed" }),
    ).toBe(false);
    expect(canReadTemplate({ ...t, audience: "all_players" }, null)).toBe(
      false,
    );
  });
  it("permits placement only after all-player reveal", () => {
    for (const audience of ["gm_only", "selected_players"])
      expect(canPlaceTemplate({ audience, status: "active" })).toBe(false);
    expect(
      canPlaceTemplate({ audience: "all_players", status: "active" }),
    ).toBe(true);
    expect(
      canPlaceTemplate({ audience: "all_players", status: "archived" }),
    ).toBe(false);
  });
  it("binds reads to current member authority and generation", () => {
    expect(templateReadScope(member, "actual")).toMatchObject({
      mode: "member",
      userId: "player",
      generation: 2,
      readerKey: "actual",
    });
    expect(
      templateReadScope({ ...member, role: "co_gm" }, "preview"),
    ).toMatchObject({ mode: "gm", readerKey: "preview" });
  });
});
