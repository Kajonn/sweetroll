import assert from "node:assert/strict";
import { test } from "vitest";
import { selectVerifiedCommit, waitForDeployment, verifyHosted } from "./railway-deploy.mjs";

const sha = "a".repeat(40);
const other = "b".repeat(40);
const deploymentId = "11111111-1111-1111-1111-111111111111";

test("selects the latest verified main commit and rejects an unverified requested commit", () => {
  const runs = [
    { head_sha: other, event: "push", head_branch: "main", conclusion: "failure" },
    { head_sha: sha, event: "push", head_branch: "main", conclusion: "success" },
  ];
  assert.equal(selectVerifiedCommit(runs, { event: "push", branch: "main" }), sha);
  assert.throws(() => selectVerifiedCommit(runs, { event: "push", branch: "main", sha: other }));
});

test("requires a successful CI run for the exact PR head and repository", () => {
  const options = { event: "pull_request", sha, repository: "Kajonn/sweetroll" };
  const good = { head_sha: sha, event: "pull_request", conclusion: "success", head_repository: { full_name: "Kajonn/sweetroll" } };
  assert.equal(selectVerifiedCommit([good], options), sha);
  assert.throws(() => selectVerifiedCommit([{ ...good, head_sha: other }], options));
  assert.throws(() => selectVerifiedCommit([{ ...good, head_repository: { full_name: "fork/sweetroll" } }], options));
});

test("waits for the exact deployment and rejects failures and superseded deployments", async () => {
  const listing = (status) => [{ id: deploymentId, status }];
  let calls = 0;
  await waitForDeployment(deploymentId, () => listing(++calls === 1 ? "BUILDING" : "SUCCESS"), async () => {});
  assert.equal(calls, 2);
  await assert.rejects(waitForDeployment(deploymentId, () => listing("FAILED")), /FAILED/);
  await assert.rejects(waitForDeployment(deploymentId, () => [
    { id: "newer", status: "BUILDING" }, ...listing("SUCCESS"),
  ]), /superseded/);
});

function fixture({ signedIn, type = "application/json" }) {
  const seen = [];
  let session = false;
  return { seen, fetch: async (url, request) => {
    const path = new URL(url).pathname;
    seen.push(path);
    if (path === "/health/ready") return Response.json({ status: "ok" });
    if (path === "/") return new Response("<!DOCTYPE html>", { headers: { "content-type": "text/html" } });
    if (path === "/dev/signin") {
      session = signedIn;
      return new Response(type === "text/html" ? "<html></html>" : "{}", {
        headers: { "content-type": type, ...(signedIn ? { "set-cookie": "session=fixture; HttpOnly" } : {}) },
      });
    }
    if (path === "/api/signout") {
      session = false;
      return new Response(null, { status: 204 });
    }
    assert.equal(path, "/api/me");
    return Response.json({ state: session && request.headers?.cookie ? "authenticated" : "anonymous" });
  } };
}

test("acceptance authenticates and signs out, while production can return the SPA fallback", async () => {
  const acceptance = fixture({ signedIn: true });
  await verifyHosted("https://acceptance.example.com", "acceptance", acceptance.fetch);
  assert.ok(acceptance.seen.includes("/api/signout"));
  const production = fixture({ signedIn: false, type: "text/html" });
  await verifyHosted("https://production.example.com", "production", production.fetch);
  assert.ok(!production.seen.includes("/api/signout"));
});

test("production rejects a fixture session and revokes it if the app created one", async () => {
  const production = fixture({ signedIn: true });
  await assert.rejects(verifyHosted("https://production.example.com", "production", production.fetch), /fixture session/);
  assert.ok(production.seen.includes("/api/signout"));
});
