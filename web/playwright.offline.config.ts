import { defineConfig } from "@playwright/test";

/**
 * Production-browser offline config. Unlike the dev-server E2E config, this
 * runs against a production build served by `vite preview` (same-origin
 * `/api` + `/dev` forwarding and SPA fallback come from `vite.config.ts`),
 * so the asset service worker actually installs and controls the page.
 *
 * The backend is the real HTTP process in `NODE_ENV=production` with the
 * test-only `SWEETROLL_TEST_AUTH=1` escape hatch: `/dev/signin` resolves the
 * existing deterministic test-identity adapter fixture (`code-test-a` /
 * `code-test-b`) so browser contexts authenticate without a production
 * synthetic user. The production UI never renders the dev sign-in panel
 * (it mounts only when `import.meta.env.MODE === "development"`), so the
 * fixture posts to the endpoint directly.
 *
 * Run `npm run web:build` first, then
 * `DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll
 *  AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes
 *  npm run web:test:offline`.
 */
const databaseUrl = process.env.DATABASE_URL ?? "postgres://sweetroll:sweetroll@localhost:5432/sweetroll";
const rollSecret = process.env.AUTHORITATIVE_ROLL_SECRET ?? "development-only-roll-secret-32-bytes";

export default defineConfig({
  testDir: "./tests/offline",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  use: { baseURL: "http://localhost:4173", trace: "retain-on-failure" },
  webServer: [
    {
      command: "npm run migrate && npx tsx src/bootstrap/http.ts",
      url: "http://localhost:3000/health/ready",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: "..",
      env: {
        DATABASE_URL: databaseUrl,
        AUTHORITATIVE_ROLL_SECRET: rollSecret,
        NODE_ENV: "production",
        SWEETROLL_TEST_AUTH: "1",
        PORT: "3000",
      },
    },
    {
      command: "npm run preview",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { PORT: "4173" },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
