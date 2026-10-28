import { describe, expect, it } from "vitest";
import { charactersRouteDefinitions } from "./characters.js";
import { campaignsRouteDefinitions } from "./campaigns.js";

describe("current-version API", () => {
  it("does not expose character migrations or campaign upgrades", () => {
    const paths = [...charactersRouteDefinitions, ...campaignsRouteDefinitions].map(route => route.path);
    expect(paths.filter(path => /migration|upgrade|rollback/.test(path))).toEqual([]);
  });
});
