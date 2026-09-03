import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("loads explicit settings", () => {
    expect(
      loadConfig({
        DATABASE_URL: "postgres://sweetroll:secret@db:5432/sweetroll",
        HOST: "127.0.0.1",
        LOG_LEVEL: "debug",
        PORT: "4100",
      }),
    ).toEqual({
      databaseUrl: "postgres://sweetroll:secret@db:5432/sweetroll",
      host: "127.0.0.1",
      logLevel: "debug",
      port: 4100,
    });
  });

  it("uses safe process defaults", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://localhost/sweetroll" })).toEqual({
      databaseUrl: "postgres://localhost/sweetroll",
      host: "0.0.0.0",
      logLevel: "info",
      port: 3000,
    });
  });

  it.each([
    [{}, "DATABASE_URL is required"],
    [{ DATABASE_URL: "postgres://localhost/db", PORT: "0" }, "PORT must be an integer from 1 through 65535"],
    [{ DATABASE_URL: "postgres://localhost/db", PORT: "3.5" }, "PORT must be an integer from 1 through 65535"],
    [{ DATABASE_URL: "postgres://localhost/db", LOG_LEVEL: "verbose" }, "LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent"],
  ])("rejects invalid environment %#", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
