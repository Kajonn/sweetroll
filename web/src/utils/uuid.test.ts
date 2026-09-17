import { describe, expect, it } from "vitest";

import { randomUUID } from "./uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUUID", () => {
  it("returns v4-shaped unique ids", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });

  it("falls back to getRandomValues when crypto.randomUUID is missing (insecure http context)", () => {
    const cryptoObj = globalThis.crypto as unknown as Record<string, unknown>;
    const hadOwn = Object.prototype.hasOwnProperty.call(cryptoObj, "randomUUID");
    const original = cryptoObj["randomUUID"];
    Object.defineProperty(cryptoObj, "randomUUID", { value: undefined, configurable: true });
    try {
      const id = randomUUID();
      expect(id).toMatch(UUID_V4);
    } finally {
      if (hadOwn) {
        Object.defineProperty(cryptoObj, "randomUUID", { value: original, configurable: true });
      } else {
        delete cryptoObj["randomUUID"];
      }
    }
    expect(globalThis.crypto.randomUUID).toBeDefined();
  });
});
