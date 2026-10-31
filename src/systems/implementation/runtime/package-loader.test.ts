import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createPostgresPublishedPackageLoader } from "./package-loader.js";
import { d20Package } from "../package/fixtures/d20.js";
it("uses the caller transaction for a campaign-locked published source read without borrowing another connection", async () => {
  const row = {
    package_json: d20Package,
    checksum: d20Package.integrity.checksum,
  };
  const outside = vi.fn().mockResolvedValue({ rows: [row] }),
    inside = vi.fn().mockResolvedValue({ rows: [row] });
  const load = createPostgresPublishedPackageLoader({
    query: outside,
  } as unknown as Pool);
  await (load as (id: string, client: PoolClient) => Promise<unknown>)(
    d20Package.versionId,
    { query: inside } as unknown as PoolClient,
  );
  expect(inside).toHaveBeenCalledOnce();
  expect(outside).not.toHaveBeenCalled();
});
