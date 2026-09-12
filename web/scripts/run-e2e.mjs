#!/usr/bin/env node
// Canonical E2E orchestration: sequential isolated journey + visual runs in
// run-scoped databases. Direct `npx playwright test` remains available for
// targeted investigation with caller-managed test resources.
//
// Required: E2E_DATABASE_ADMIN_URL (test-service connection with CREATE
// DATABASE permission, not a database to reset). Children receive
// DATABASE_URL, CI=1, and SWEETROLL_E2E_SUITE=journeys|visual.
//
// Repeat counts (e.g. --repeat-each=5) forward to both suites. Do not pass a
// single --output path: each phase writes to its own run-scoped directory
// under ignored web/test-results/<runId>/. Repeated full runs accumulate
// fixtures per database, so a large repeat count may push catalog fixtures
// past the first page; use targeted direct Playwright runs with isolated
// resources for large repeats instead.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(WEB_DIR);

export function buildSuffix() {
  return randomUUID().replaceAll("-", "");
}

export function buildDatabaseNames(suffix) {
  return {
    journeys: `sweetroll_e2e_j_${suffix}`,
    visual: `sweetroll_e2e_v_${suffix}`,
  };
}

export function sanitizeForLog(value) {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "[redacted]";
  }
}

export function withDatabase(adminUrl, dbName) {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export function adminDatabaseName(adminUrl) {
  return new URL(adminUrl).pathname.replace(/^\//, "");
}

export function parseExtraArgs(argv) {
  for (const arg of argv) {
    if (arg === "--output" || arg.startsWith("--output=")) {
      throw new Error("Do not pass --output: each phase uses its own run-scoped output directory.");
    }
  }
  return [...argv];
}

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${name}`);
  }
  return `"${name}"`;
}

function runPlaywright({ suite, databaseUrl, outputDir, extraArgs, spawnFn, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ["playwright", "test", ...extraArgs, "--output", outputDir];
    const child = spawnFn("npx", args, {
      cwd: WEB_DIR,
      env: { ...env, DATABASE_URL: databaseUrl, CI: "1", SWEETROLL_E2E_SUITE: suite },
      stdio: "inherit",
    });
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      cleanupSignals();
      resolvePromise(code ?? 1);
    };
    const onSignal = (signal) => {
      try {
        child.kill(signal);
      } catch {}
    };
    const cleanupSignals = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const onSigint = () => onSignal("SIGINT");
    const onSigterm = () => onSignal("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.on("error", (err) => {
      cleanupSignals();
      rejectPromise(err);
    });
    child.on("exit", (code) => finish(typeof code === "number" ? code : 1));
  });
}

export async function runE2e({
  adminUrl = process.env.E2E_DATABASE_ADMIN_URL,
  extraArgs = [],
  suffix = buildSuffix(),
  createClient,
  spawnFn = spawn,
  env = process.env,
} = {}) {
  const forwarded = parseExtraArgs(extraArgs);
  if (!adminUrl) {
    throw new Error(
      "Missing E2E_DATABASE_ADMIN_URL: provide a test-service connection with CREATE DATABASE permission.",
    );
  }
  const names = buildDatabaseNames(suffix);
  const runId = suffix;
  const outputs = {
    journeys: resolve(WEB_DIR, "test-results", runId, "journeys"),
    visual: resolve(WEB_DIR, "test-results", runId, "visual"),
  };
  if (!createClient) {
    const { Client } = await import("pg");
    createClient = (connectionString) => new Client({ connectionString });
  }
  const client = createClient(adminUrl);
  const created = [];
  const connect = async () => {
    if (typeof client.connect === "function") await client.connect();
  };
  const query = (text) => client.query(text);
  try {
    try {
      await connect();
    } catch (err) {
      throw new Error("E2E setup failed: cannot connect with E2E_DATABASE_ADMIN_URL.");
    }
    for (const dbName of [names.journeys, names.visual]) {
      try {
        await query(`CREATE DATABASE ${quoteIdent(dbName)}`);
      } catch (err) {
        throw new Error(`E2E setup failed: cannot CREATE DATABASE (check permission): ${String(err?.message ?? err)}`);
      }
      created.push(dbName);
    }
    let failed = false;
    for (const suite of ["journeys", "visual"]) {
      const code = await runPlaywright({
        suite,
        databaseUrl: withDatabase(adminUrl, names[suite]),
        outputDir: outputs[suite],
        extraArgs: forwarded,
        spawnFn,
        env,
      });
      if (code !== 0) failed = true;
    }
    if (failed) {
      const err = new Error(`E2E suites failed (run ${runId}).`);
      err.code = 1;
      throw err;
    }
    return { runId, databases: names, outputs };
  } finally {
    for (const dbName of created) {
      try {
        await query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
      } catch {}
    }
    try {
      if (typeof client.end === "function") await client.end();
    } catch {}
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runE2e({ extraArgs: process.argv.slice(2) }).then(
    () => {},
    (err) => {
      console.error(String(err?.message ?? err));
      process.exit(typeof err?.code === "number" ? err.code : 1);
    },
  );
}
