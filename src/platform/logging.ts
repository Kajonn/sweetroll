import pino, { type Logger } from "pino";

import type { LogLevel } from "./config.js";

export function createLogger(level: LogLevel): Logger {
  return pino({
    base: { service: "sweetroll" },
    level,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "databaseUrl"],
      censor: "[REDACTED]",
    },
  });
}
