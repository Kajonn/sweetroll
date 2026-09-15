import { describe, expect, it } from "vitest";
import pino from "pino";

import { createPool } from "./database.js";

describe("createPool", () => {
  it("bounds connection establishment and pool acquisition", async () => {
    const pool = createPool("postgres://localhost/sweetroll", pino({ enabled: false }));

    try {
      expect(pool.options.connectionTimeoutMillis).toBe(250);
    } finally {
      await pool.end();
    }
  });

  it("survives idle-client errors via the listener instead of throwing", async () => {
    const lines: string[] = [];
    const logger = pino({ base: null, timestamp: false }, { write: (line) => lines.push(line) });
    const pool = createPool("postgres://localhost/sweetroll", logger);

    try {
      expect(() => pool.emit("error", new Error("boom"))).not.toThrow();
      expect(lines.join("\n")).toContain("boom");
    } finally {
      await pool.end();
    }
  });
});
