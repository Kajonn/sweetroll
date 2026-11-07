import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { scenario } from "./runner.js";

scenario("parallel campaigns keep separate state and access", async ({ actor, phase, versionId }) => {
  const gm = await actor("ada", ["campaigns:read", "campaigns:write"]);
  const outsider = await actor("bob", ["campaigns:read"]);

  await phase("Open two campaigns");
  type Campaign = { campaignId: string; title: string };
  const first = { title: "River Keep", systemVersionId: versionId, idempotencyKey: randomUUID() };
  const [river, coast] = await Promise.all([
    gm.command<Campaign>("POST /campaigns", first, 201),
    gm.command<Campaign>("POST /campaigns", { title: "Salt Coast", systemVersionId: versionId }, 201),
  ]);
  expect(river.campaignId).not.toBe(coast.campaignId);

  await phase("Retry and verify access");
  expect(await gm.command<Campaign>("POST /campaigns", first, 201)).toMatchObject(river);
  const { campaigns } = await gm.json<{ campaigns: Campaign[] }>("GET /campaigns");
  expect(campaigns.map(({ title }) => title).sort()).toEqual(["River Keep", "Salt Coast"]);
  expect(await gm.json(`GET /campaigns/${coast.campaignId}`)).toMatchObject({ title: "Salt Coast" });
  await outsider.status(`GET /campaigns/${river.campaignId}`, 404);
  await outsider.status(`GET /campaigns/${coast.campaignId}`, 404);
});
