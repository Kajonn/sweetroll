# Sweetroll API scenarios

Install the root dependencies with `npm ci` and point `TEST_DATABASE_URL` at a test PostgreSQL database. The runner creates and drops an isolated schema and temporary image storage for each scenario.

```sh
npm run test:scenario                         # all scenarios
npm run test:scenario -- -t Knave             # one scenario by title
SWEETROLL_SCENARIO_TRACE=1 npm run test:scenario -- -t Knave
```

Add a `*.test.ts` file in this directory. Vitest discovers it for both `test:scenario` and the normal integration suite. Copy the [two-campaign example](campaign-isolation.test.ts) or follow this minimal pattern.

```ts
import { expect } from "vitest";
import { scenario } from "./runner.js";

scenario("the GM opens a campaign", async ({ actor, phase, versionId }) => {
  const gm = await actor("ada", ["campaigns:read", "campaigns:write"]);
  await phase("Create campaign");
  const { campaignId } = await gm.command<{ campaignId: string }>("POST /campaigns", {
    title: "Night Road", systemVersionId: versionId,
  }, 201);
  expect(await gm.json(`GET /campaigns/${campaignId}`)).toMatchObject({ title: "Night Road" });
});
```

- Use `actor` with `ada`, `bob`, `cara`, `dan`, `eve` or `finn` and the required [API scopes](../../../docs/api/v1.md). `versionId` is an existing d20 fixture owned by `ada`. [Knave](knave.test.ts) publishes its own rules as part of the scenario.
- Use `json` for ordinary requests, `command` for writes that require an idempotency key, and `status` to check an expected status without reading the body. `json` and `command` default to HTTP 200. Pass an explicit `idempotencyKey` in the command body when testing retries. Use returned IDs and revisions, and deliberately reuse stale revisions when testing conflicts.
- Use ordinary TypeScript loops for repeated turns and `Promise.all` for overlapping requests. Call `phase` between groups of requests to label the timeline. Knave passes `{ resetRateLimits: true }` at its existing phase boundaries so it can run without minute-long pauses. Leave quotas active when testing pacing or rate limits. The optional third `scenario` argument sets a custom timeout in milliseconds.
- The runner prints the last 20 requests on failure. Set `SWEETROLL_SCENARIO_TRACE=1` for the full timeline on any run. It includes actor, phase, route path, timing and status. It omits credentials, query strings and bodies.

Scenarios exercise `/api/v1` in-process against real PostgreSQL. Use the existing browser and streaming suites for GUI, offline-client, and display transport behavior.
