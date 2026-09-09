import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

test("player styles consume only semantic tokens", () => {
  const dir = join(process.cwd(), "src/player");
  const files = readdirSync(dir).filter((f) => f.endsWith(".module.css"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const src = readFileSync(join(dir, file), "utf8");
    expect(src, file).not.toMatch(/var\(--color-/);
  }
});
