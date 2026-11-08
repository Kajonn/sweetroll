import { describe, expect, it } from "vitest";

import { generateDisplayCode } from "./display.js";

describe("generateDisplayCode", () => {
  it("yields 8-char codes over the uppercase alphanumeric alphabet without modulo bias", () => {
    const counts = new Map<string, number>();
    const samples = 6_000;
    let total = 0;
    for (let index = 0; index < samples; index++) {
      const code = generateDisplayCode();
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
      for (const char of code) counts.set(char, (counts.get(char) ?? 0) + 1);
      total += code.length;
    }
    expect(counts.size).toBe(36);
    // `byte % 36` over 0..255 gives A..D 8/256 each instead of 1/36. With
    // 48000 characters that is about 6000 versus 5333 (sd ~69) when uniform;
    // the threshold sits halfway between the two.
    const uniform = (total * 4) / 36;
    const biased = (total * 32) / 256;
    const firstFour = [..."ABCD"].reduce((sum, char) => sum + (counts.get(char) ?? 0), 0);
    expect(firstFour).toBeLessThan((uniform + biased) / 2);
  });
});
