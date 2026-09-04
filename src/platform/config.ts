const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type AppConfig = {
  cookieSecure: boolean;
  databaseUrl: string;
  host: string;
  logLevel: LogLevel;
  port: number;
  sessionCookieName: string;
  sessionTtlDays: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }

  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535");
  }

  const logLevel = env.LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.some((candidate) => candidate === logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }

  const sessionTtlDays = Number(env.SESSION_TTL_DAYS ?? "30");
  if (!Number.isInteger(sessionTtlDays) || sessionTtlDays < 1 || sessionTtlDays > 365) {
    throw new Error("SESSION_TTL_DAYS must be an integer from 1 through 365");
  }

  const cookieSecure = env.COOKIE_SECURE === "true";

  return {
    cookieSecure,
    databaseUrl,
    host: env.HOST ?? "0.0.0.0",
    logLevel: logLevel as LogLevel,
    port,
    sessionCookieName: env.SESSION_COOKIE_NAME ?? "session",
    sessionTtlDays,
  };
}
