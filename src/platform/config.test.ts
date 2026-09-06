import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("loads explicit settings", () => {
    expect(
      loadConfig({
        ALLOWED_ORIGINS: "https://app.example.com, https://preview.example.com",
        COOKIE_SECURE: "true",
        AUTHORITATIVE_ROLL_SECRET: "0123456789abcdef0123456789abcdef",
        DATABASE_URL: "postgres://sweetroll:secret@db:5432/sweetroll",
        HOST: "127.0.0.1",
        LOG_LEVEL: "debug",
        NODE_ENV: "production",
        PORT: "4100",
        SESSION_COOKIE_NAME: "sid",
        SESSION_TTL_DAYS: "7",
      }),
    ).toEqual({
      allowedOrigins: ["https://app.example.com", "https://preview.example.com"],
      cookieSecure: true,
      authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
      databaseUrl: "postgres://sweetroll:secret@db:5432/sweetroll",
      host: "127.0.0.1",
      logLevel: "debug",
      nodeEnv: "production",
      port: 4100,
      sessionCookieName: "sid",
      sessionTtlDays: 7,
    });
  });

  it("uses safe process defaults", () => {
    expect(loadConfig({
      AUTHORITATIVE_ROLL_SECRET: "0123456789abcdef0123456789abcdef",
      DATABASE_URL: "postgres://localhost/sweetroll",
    })).toEqual({
      allowedOrigins: [],
      cookieSecure: false,
      authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
      databaseUrl: "postgres://localhost/sweetroll",
      host: "0.0.0.0",
      logLevel: "info",
      nodeEnv: "development",
      port: 3000,
      sessionCookieName: "session",
      sessionTtlDays: 30,
    });
  });

  it("allows tests to omit the authoritative roll secret", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://localhost/sweetroll", NODE_ENV: "test" }))
      .toMatchObject({ authoritativeRollSecret: "", nodeEnv: "test" });
  });

  it.each([
    [{}, "DATABASE_URL is required"],
    [{ DATABASE_URL: "postgres://localhost/db", PORT: "0" }, "PORT must be an integer from 1 through 65535"],
    [{ DATABASE_URL: "postgres://localhost/db", PORT: "3.5" }, "PORT must be an integer from 1 through 65535"],
    [{ DATABASE_URL: "postgres://localhost/db", LOG_LEVEL: "verbose" }, "LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent"],
    [{ DATABASE_URL: "postgres://localhost/db", SESSION_TTL_DAYS: "0" }, "SESSION_TTL_DAYS must be an integer from 1 through 365"],
    [{ DATABASE_URL: "postgres://localhost/db", NODE_ENV: "staging" }, "NODE_ENV must be development, production, or test"],
    [{ DATABASE_URL: "postgres://localhost/db" }, "AUTHORITATIVE_ROLL_SECRET is required outside tests"],
    [{ DATABASE_URL: "postgres://localhost/db", AUTHORITATIVE_ROLL_SECRET: "short" }, "AUTHORITATIVE_ROLL_SECRET must be at least 32 UTF-8 bytes"],
  ])("rejects invalid environment %#", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
