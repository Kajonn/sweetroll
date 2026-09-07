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
 * I4 remediation uses dedicated resources that never touch the user's
 * manual-test app (ports 3000/5173 + `sweetroll` DB):
 * backend port 3100, preview port 4174, database `sweetroll_i4remed`.
 * Override with BACKEND_PORT / PREVIEW_PORT / DATABASE_URL when needed.
 *
 * Run `npm run web:build` first, then
 * `DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_i4remed
 *  AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes
 *  SWEETROLL_TEST_AUTH=1
 *  npm run web:test:offline`.
 */
const backendPort = process.env.BACKEND_PORT ?? "3100";
const previewPort = process.env.PREVIEW_PORT ?? "4174";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://sweetroll:sweetroll@localhost:5432/sweetroll_i4remed";
const rollSecret = process.env.AUTHORITATIVE_ROLL_SECRET ?? "development-only-roll-secret-32-bytes";

export default defineConfig({
  testDir: "./tests/offline",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  use: { baseURL: `http://localhost:${previewPort}`, trace: "retain-on-failure" },
  webServer: [
    {
      command: "npm run migrate && npx tsx src/bootstrap/http.ts",
      url: `http://localhost:${backendPort}/health/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: "..",
      env: {
        DATABASE_URL: databaseUrl,
        AUTHORITATIVE_ROLL_SECRET: rollSecret,
        NODE_ENV: "production",
        SWEETROLL_TEST_AUTH: "1",
        PORT: backendPort,
      },
    },
    {
      command: "npm run preview",
      url: `http://localhost:${previewPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        PORT: previewPort,
        PREVIEW_PORT: previewPort,
        SWEETROLL_BACKEND_TARGET: `http://localhost:${backendPort}`,
      },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
