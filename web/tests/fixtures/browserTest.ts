import { test as base } from "@playwright/test";
import { Client } from "pg";

export { expect } from "@playwright/test";
export type * from "@playwright/test";

export const test = base.extend<{ freshTestAccountQuotas: void }>({
  // Independent journeys reuse the seeded accounts for deterministic fixtures.
  // Only clear their budgets in the runner's explicitly disposable database.
  freshTestAccountQuotas: [async ({}, use) => {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString && process.env.SWEETROLL_E2E_EPHEMERAL_DB === "1") {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await client.query(
          `DELETE FROM public_api_rate_limits AS limits
           WHERE EXISTS (
             SELECT 1 FROM external_identities AS identity
             WHERE identity.user_id = limits.user_id AND identity.provider = 'test'
           )`,
        );
      } finally {
        await client.end();
      }
    }
    await use();
  }, { auto: true }],
});
