import { describe, expect, it } from "vitest";

import { generateDisplayCode } from "./display.js";

describe("generateDisplayCode", () => {
  it("yields 6-char codes over the uppercase alphanumeric alphabet without modulo bias", () => {
    const counts = new Map<string, number>();
    const samples = 6_000;
    for (let index = 0; index < samples; index++) {
      const code = generateDisplayCode();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
      for (const char of code) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    expect(counts.size).toBe(36);
    // `byte % 36` over 0..255 gives A..D 8/256 each instead of 1/36: about
    // 4500 of 36000 characters versus 4000 (sd ~62) when uniform.
    const firstFour = [..."ABCD"].reduce((sum, char) => sum + (counts.get(char) ?? 0), 0);
    expect(firstFour).toBeLessThan(4250);
  });
});
