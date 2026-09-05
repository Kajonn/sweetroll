import { describe, expect, it } from "vitest";

import { createDeterministicRng } from "./deterministic-rng.js";

describe("createDeterministicRng", () => {
  it("streams unsigned big-endian words from consecutive HMAC-SHA256 blocks", () => {
    const rng = createDeterministicRng(
      "0123456789abcdef0123456789abcdef",
      "exec-a",
    );

    expect(Array.from({ length: 9 }, () => rng())).toEqual([
      0.6252501993440092,
      0.5260136849246919,
      0.46815150417387486,
      0.8200751733966172,
      0.45636919629760087,
      0.5305023458786309,
      0.9994043332990259,
      0.4184548300690949,
      0.4204392444808036,
    ]);
  });
});
