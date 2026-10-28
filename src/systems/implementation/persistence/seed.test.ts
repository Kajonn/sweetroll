import { describe, expect, it } from "vitest";
import { seedReferenceTemplates, REFERENCE_TEMPLATES } from "./repository.js";

describe("reference template initialization", () => {
  it("only inserts missing templates and never probes or repairs historical versions", async () => {
    const statements: string[] = [];
    const runner = {
      async query(sql: string) {
        statements.push(sql);
        if (sql.startsWith("INSERT INTO")) return { rows: [], rowCount: 0 };
        throw new Error("Initialization must not read or rewrite existing rows");
      },
    };
    expect(await seedReferenceTemplates(runner as never)).toEqual({ systemsInserted: 0, versionsInserted: 0 });
    expect(statements).toHaveLength(REFERENCE_TEMPLATES.length * 2);
    expect(statements.every(sql => sql.includes("ON CONFLICT (id) DO NOTHING"))).toBe(true);
  });
});
