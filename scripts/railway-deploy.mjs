import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const commitPattern = /^[0-9a-f]{40}$/;
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function selectVerifiedCommit(runs, { event, branch, sha, repository }) {
  const run = runs.find((candidate) =>
    candidate.conclusion === "success" && candidate.event === event &&
    (!branch || candidate.head_branch === branch) && (!sha || candidate.head_sha === sha) &&
    (!repository || candidate.head_repository?.full_name === repository),
  );
  if (!commitPattern.test(run?.head_sha ?? "")) throw Error("No successful CI run found for the requested commit");
  return run.head_sha;
}

export async function waitForDeployment(id, list, pause = delay) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const deployments = list();
    const deployment = deployments.find((entry) => entry.id === id);
    if (deployment && deployments[0].id !== id) throw Error(`Railway deployment ${id} was superseded`);
    if (deployment?.status === "SUCCESS") return;
    if (["FAILED", "CRASHED", "REMOVED", "REMOVING", "SKIPPED", "NEEDS_APPROVAL"].includes(deployment?.status)) {
      throw Error(`Railway deployment ${id} reached ${deployment.status}`);
    }
    await pause(10_000);
  }
  throw Error(`Timed out waiting for Railway deployment ${id}`);
}

export async function verifyHosted(url, tier, fetcher = fetch) {
  const origin = new URL(url).origin;
  if (!origin.startsWith("https://") || origin !== url.replace(/\/$/, "")) throw Error("Expected an HTTPS deployment origin");
  if (!["acceptance", "production"].includes(tier)) throw Error("Unknown deployment tier");

  const request = (path, init) => fetcher(origin + path, {
    redirect: "error", signal: AbortSignal.timeout(15_000), ...init,
  });
  const ready = await request("/health/ready");
  if (!ready.ok || (await ready.json()).status !== "ok") throw Error("App is not ready");
  const index = await request("/");
  if (!index.ok || !index.headers.get("content-type")?.includes("text/html")) throw Error("GUI entry point is unavailable");
  await index.body?.cancel();

  const signin = await request("/dev/signin", {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code: "code-dev", redirectUri: origin + "/cb" }),
  });
  const cookie = signin.headers.get("set-cookie")?.split(";", 1)[0];
  const signinOk = signin.ok && signin.headers.get("content-type")?.includes("application/json");
  await signin.body?.cancel();
  const sessionState = async () => {
    const result = await request("/api/me", cookie ? { headers: { cookie } } : {});
    if (!result.ok) throw Error("Could not read the live session");
    return (await result.json()).state;
  };
  let state;
  try {
    state = await sessionState();
  } finally {
    if (cookie) {
      const signout = await request("/api/signout", { method: "POST", headers: { origin, cookie } });
      if (!signout.ok) throw Error("Could not revoke the smoke-test session");
    }
  }
  if (tier === "production") {
    if (state !== "anonymous" || cookie || signinOk) throw Error("Production accepted a fixture session");
  } else {
    if (!signinOk || !cookie || state !== "authenticated") throw Error("Acceptance test sign-in failed");
    if (await sessionState() !== "anonymous") throw Error("Acceptance test session survived sign-out");
  }
}

function exec(command, args, options) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options }).trim();
}

function resolveCommit(kind, input) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw Error("GITHUB_REPOSITORY is required");
  const api = (path, fields = []) => JSON.parse(exec("gh", [
    "api", "--method", "GET", `repos/${repository}/${path}`, ...fields.flatMap((field) => ["-f", field]),
  ]));
  const event = kind === "pr" ? "pull_request" : "push";
  let sha;
  if (kind === "pr") {
    if (!/^[1-9][0-9]*$/.test(input ?? "")) throw Error("A PR number is required");
    const pr = api(`pulls/${input}`);
    if (pr.state !== "open" || pr.base.ref !== "main" || pr.head.repo?.full_name !== repository) {
      throw Error("Select an open PR from this repository targeting main");
    }
    sha = pr.head.sha;
  } else if (kind === "production") {
    sha = input;
  } else if (kind !== "main") {
    throw Error("Unknown commit selection");
  }
  if (kind !== "main" && !commitPattern.test(sha ?? "")) throw Error("A full commit SHA is required");
  const branch = event === "push" ? "main" : undefined;
  const fields = [`event=${event}`, "status=success", "per_page=50"];
  if (branch) fields.push(`branch=${branch}`);
  if (sha) fields.push(`head_sha=${sha}`);
  const verified = selectVerifiedCommit(api("actions/workflows/ci.yml/runs", fields).workflow_runs,
    { event, branch, sha, repository });
  if (branch && !["ahead", "identical"].includes(api(`compare/${verified}...main`).status)) {
    throw Error("The selected commit is outside current main history");
  }
  return verified;
}

function target() {
  const { RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID, RAILWAY_TOKEN } = process.env;
  if (![RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID].every((id) => idPattern.test(id ?? "")) || !RAILWAY_TOKEN) {
    throw Error("Set the Railway target IDs and environment-scoped token");
  }
  return ["--project", RAILWAY_PROJECT_ID, "--environment", RAILWAY_ENVIRONMENT_ID, "--service", RAILWAY_SERVICE_ID];
}

function listDeployments(flags) {
  return JSON.parse(exec("railway", ["deployment", "list", ...flags, "--limit", "20", "--json"]));
}

async function main([action, value, arg, tier]) {
  if (action === "select") {
    const sha = resolveCommit(value, arg);
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
    return;
  }

  if (action === "wait") {
    if (!idPattern.test(value ?? "")) throw Error("A Railway deployment ID is required");
    const flags = target();
    await waitForDeployment(value, () => listDeployments(flags));
    return;
  }

  if (action !== "deploy" || !["acceptance", "production"].includes(tier)) throw Error("Unknown Railway deploy command");
  const flags = target();
  const sha = arg;
  const cwd = value;
  if (!commitPattern.test(sha ?? "") || exec("git", ["rev-parse", "HEAD"], { cwd }) !== sha) {
    throw Error("The upload checkout does not match the verified commit");
  }
  const url = process.env.RAILWAY_APP_URL;
  const origin = new URL(url).origin;
  if (!origin.startsWith("https://") || origin !== url.replace(/\/$/, "")) throw Error("Expected an HTTPS deployment origin");
  const upload = JSON.parse(exec("railway", [
    "up", ...flags, "--detach", "--json", "--message", `Sweetroll ${tier} ${sha}`,
  ], { cwd }));
  const id = upload.deploymentId;
  if (!idPattern.test(id ?? "")) throw Error("Railway did not return a deployment ID");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n- ${tier}: \`${sha}\` → \`${id}\` ([open app](${url}))\n`);
  await waitForDeployment(id, () => listDeployments(flags));
  await verifyHosted(url, tier);
  if (listDeployments(flags)[0]?.id !== id) throw Error("Deployment was superseded during hosted verification");
  appendFileSync(process.env.GITHUB_OUTPUT, `deployment_id=${id}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
