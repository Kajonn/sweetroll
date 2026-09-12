// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  adminDatabaseName,
  buildDatabaseNames,
  parseExtraArgs,
  runE2e,
  sanitizeForLog,
  withDatabase,
} from "./run-e2e.mjs";

function stubClient({ createFailsOn = -1 }: { createFailsOn?: number } = {}) {
  const queries: string[] = [];
  let creates = 0;
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(async (text: string) => {
      queries.push(text);
      if (text.startsWith("CREATE DATABASE")) {
        if (creates === createFailsOn) throw new Error("permission denied");
        creates += 1;
      }
      return {};
    }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  return { client, queries };
}

function stubSpawn(exitCodes: number[]) {
  const calls: Array<{ cmd: string; args: string[]; options: any }> = [];
  const spawnFn = (cmd: string, args: string[], options: any) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => {};
    const code = exitCodes[calls.length - 1] ?? 0;
    queueMicrotask(() => (child as EventEmitter).emit("exit", code));
    return child as never;
  };
  return { calls, spawnFn };
}

const ADMIN = "postgres://sweetroll:secret123@localhost:5432/sweetroll";

describe("run-e2e orchestration", () => {
  it("builds distinct run-scoped database names", () => {
    const names = buildDatabaseNames("abc123");
    expect(names.journeys).toBe("sweetroll_e2e_j_abc123");
    expect(names.visual).toBe("sweetroll_e2e_v_abc123");
    expect(names.journeys).not.toBe(names.visual);
    expect(adminDatabaseName(ADMIN)).toBe("sweetroll");
  });

  it("replaces only the URL pathname and redacts passwords", () => {
    expect(withDatabase(ADMIN, "sweetroll_e2e_j_x")).toBe(
      "postgres://sweetroll:secret123@localhost:5432/sweetroll_e2e_j_x",
    );
    expect(sanitizeForLog(ADMIN)).not.toContain("secret123");
    expect(sanitizeForLog(ADMIN)).toContain("localhost");
  });

  it("rejects a single shared --output path", () => {
    expect(() => parseExtraArgs(["--output", "x"])).toThrow(/--output/);
    expect(() => parseExtraArgs(["--output=x"])).toThrow(/--output/);
    expect(parseExtraArgs(["--repeat-each=5"])).toEqual(["--repeat-each=5"]);
  });

  it("runs journeys without visuals, then visuals only, with isolated outputs", async () => {
    const { client, queries } = stubClient();
    const { calls, spawnFn } = stubSpawn([0, 0]);
    const result = await runE2e({
      adminUrl: ADMIN,
      extraArgs: ["--repeat-each=2"],
      suffix: "run9",
      createClient: () => client as never,
      spawnFn: spawnFn as never,
      env: { KEEP: "yes" } as never,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.options.env.SWEETROLL_E2E_SUITE).toBe("journeys");
    expect(calls[1]!.options.env.SWEETROLL_E2E_SUITE).toBe("visual");
    expect(calls[0]!.options.env.DATABASE_URL).toContain("sweetroll_e2e_j_run9");
    expect(calls[1]!.options.env.DATABASE_URL).toContain("sweetroll_e2e_v_run9");
    expect(calls[0]!.options.env.CI).toBe("1");
    expect(calls[0]!.args).toContain("--repeat-each=2");
    expect(calls[0]!.args[calls[0]!.args.length - 2]).toBe("--output");
    expect(calls[0]!.options.env.SWEETROLL_E2E_SUITE).not.toBe(
      calls[1]!.options.env.SWEETROLL_E2E_SUITE,
    );
    expect(calls[0]!.args[calls[0]!.args.length - 1]).not.toBe(
      calls[1]!.args[calls[1]!.args.length - 1],
    );
    expect(result.runId).toBe("run9");
    expect(queries.filter((q) => q.startsWith("DROP DATABASE"))).toHaveLength(2);
    expect(queries.join("\n")).not.toContain("sweetroll\"");
    expect(client.end).toHaveBeenCalled();
  });

  it("runs the second suite even if the first fails and exits nonzero", async () => {
    const { client, queries } = stubClient();
    const { calls, spawnFn } = stubSpawn([1, 0]);
    await expect(
      runE2e({
        adminUrl: ADMIN,
        suffix: "fail1",
        createClient: () => client as never,
        spawnFn: spawnFn as never,
        env: {} as never,
      }),
    ).rejects.toThrow(/failed/);
    expect(calls).toHaveLength(2);
    expect(queries.filter((q) => q.startsWith("DROP DATABASE"))).toHaveLength(2);
  });

  it("limits cleanup to databases created by this invocation", async () => {
    const { client, queries } = stubClient({ createFailsOn: 1 });
    const { calls, spawnFn } = stubSpawn([0, 0]);
    await expect(
      runE2e({
        adminUrl: ADMIN,
        suffix: "partial",
        createClient: () => client as never,
        spawnFn: spawnFn as never,
        env: {} as never,
      }),
    ).rejects.toThrow(/CREATE DATABASE/);
    expect(calls).toHaveLength(0);
    const drops = queries.filter((q) => q.startsWith("DROP DATABASE"));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain("sweetroll_e2e_j_partial");
    expect(drops.join("\n")).not.toContain("sweetroll_e2e_v_partial");
  });

  it("requires an admin URL without leaking credentials", async () => {
    const { spawnFn } = stubSpawn([0, 0]);
    await expect(
      runE2e({
        adminUrl: "",
        suffix: "x",
        createClient: () => {
          throw new Error("must not be called");
        },
        spawnFn: spawnFn as never,
        env: {} as never,
      }),
    ).rejects.toThrow(/E2E_DATABASE_ADMIN_URL/);
  });
});
