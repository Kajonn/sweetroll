import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { expect, it, vi } from "vitest";

import type { PersonalTokenScope } from "../../../src/identity/personal-tokens.js";
import { seedReferenceTemplates } from "../../../src/systems/implementation/persistence/index.js";
import { buildI6Harness, type I6Harness } from "../i6-app.js";

type TestUser = "ada" | "bob" | "cara" | "dan" | "eve" | "finn";
type Write = "POST" | "PUT" | "PATCH" | "DELETE";
export type WriteRequest = `${Write} /${string}`;
type RequestLine = WriteRequest | `GET /${string}`;

function scenarioContext(harness: I6Harness) {
  const timeline: string[] = [];
  const started = performance.now();
  let currentPhase = "Setup";

  async function actor(name: TestUser, scopes: readonly PersonalTokenScope[]) {
    const signIn = await harness.app.inject({
      method: "POST", url: "/dev/signin", payload: { code: `code-${name}`, redirectUri: "http://localhost/cb" },
    });
    expect(signIn.statusCode, `Sign in as ${name}`).toBe(200);
    const { userId: actorId } = signIn.json<{ userId: string }>();
    const header = signIn.headers["set-cookie"];
    const cookie = (Array.isArray(header) ? header[0] : header)?.split(";")[0] ?? "";
    const issued = await harness.app.inject({
      method: "POST", url: "/me/personal-tokens", headers: { cookie, origin: "http://localhost", host: "localhost" },
      payload: { label: `${name} scenario`, scopes, expiresInDays: 1 },
    });
    expect(issued.statusCode, `Issue token for ${name}`).toBe(201);
    const { token } = issued.json<{ token: string }>();

    async function request(line: RequestLine, expected: number, payload?: object) {
      const method = line.slice(0, line.indexOf(" ")) as Write | "GET";
      const path = line.slice(method.length + 1);
      const at = performance.now();
      const index = timeline.length;
      const label = `${currentPhase} | ${name} | ${method} ${path.split("?")[0]}`;
      const prefix = `#${index + 1} +${Math.round(at - started)}ms ${label}`;
      timeline.push(`${prefix} → pending`);
      const response = await harness.app.inject({
        method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload }),
      });
      timeline[index] = `${prefix} → ${response.statusCode} in ${Math.round(performance.now() - at)}ms`;
      expect(response.statusCode, label).toBe(expected);
      return response;
    }

    async function json<T = unknown>(line: RequestLine, payload?: object, expected = 200): Promise<T> {
      return (await request(line, expected, payload)).json<T>();
    }

    return {
      actorId, name, json,
      command<T = unknown>(line: WriteRequest, payload: object, expected = 200): Promise<T> {
        return json<T>(line, { idempotencyKey: randomUUID(), ...payload }, expected);
      },
      async status(line: RequestLine, expected: number, payload?: object): Promise<void> {
        await request(line, expected, payload);
      },
    };
  }

  return {
    timeline,
    context: {
      actor,
      versionId: harness.versionId,
      async phase(name: string, { resetRateLimits = false } = {}): Promise<void> {
        if (resetRateLimits) await harness.pool.query("DELETE FROM public_api_rate_limits");
        currentPhase = name;
      },
      async png(color: string): Promise<string> {
        const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).png().toBuffer();
        return bytes.toString("base64");
      },
    },
  };
}

type ScenarioContext = ReturnType<typeof scenarioContext>["context"];
export type ScenarioActor = Awaited<ReturnType<ScenarioContext["actor"]>>;

export function scenario(name: string, play: (context: ScenarioContext) => Promise<void>, timeoutMs = 30_000): void {
  it.skipIf(!process.env.TEST_DATABASE_URL)(name, { timeout: timeoutMs }, async () => {
    const storage = await mkdtemp(join(tmpdir(), "sweetroll-scenario-"));
    let harness: I6Harness | undefined;
    try {
      vi.stubEnv("SWEETROLL_MEDIA_DIR", join(storage, "media"));
      vi.stubEnv("SWEETROLL_DISPLAY_DIR", join(storage, "display"));
      harness = await buildI6Harness({ publicApi: true });
      await seedReferenceTemplates(harness.pool);
      const { context, timeline } = scenarioContext(harness);
      const verbose = process.env.SWEETROLL_SCENARIO_TRACE === "1";
      try {
        await play(context);
      } catch (error) {
        if (!verbose && timeline.length > 0) console.error(`Recent requests for ${name}:\n${timeline.slice(-20).join("\n")}`);
        throw error;
      } finally {
        if (verbose) console.info(`Request timeline for ${name}:\n${timeline.join("\n")}`);
      }
    } finally {
      try {
        await harness?.close();
      } finally {
        vi.unstubAllEnvs();
        await rm(storage, { recursive: true, force: true });
      }
    }
  });
}
