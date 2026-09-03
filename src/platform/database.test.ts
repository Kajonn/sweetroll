import { describe, expect, it } from "vitest";

import { createPool } from "./database.js";

describe("createPool", () => {
  it("bounds connection establishment and pool acquisition", async () => {
    const pool = createPool("postgres://localhost/sweetroll");

    try {
      expect(pool.options.connectionTimeoutMillis).toBe(250);
    } finally {
      await pool.end();
    }
  });
});
