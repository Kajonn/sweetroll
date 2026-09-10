const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type NodeEnv = "development" | "production" | "test";

export type CampaignLimits = {
  /** Default page size for campaign and member lists. */
  pageDefault: number;
  /** Maximum page size for campaign and member lists. */
  pageMax: number;
  /** Maximum active members per campaign (supported load-test bound). */
  maxMembers: number;
  /** Maximum attached characters per campaign (supported load-test bound). */
  maxAttachedCharacters: number;
  /** Maximum campaign title length in characters. */
  maxTitleLength: number;
  /** Maximum campaign description length in characters. */
  maxDescriptionLength: number;
  /** Default invitation expiry in days. */
  invitationExpiryDefaultDays: number;
  /** Maximum invitation expiry in days. */
  invitationExpiryMaxDays: number;
  /** Maximum campaign content title length in characters. */
  maxContentTitleLength: number;
  /** Maximum campaign content body length in characters (plain text only). */
  maxContentBodyLength: number;
  /** Maximum tags per campaign content item. */
  maxContentTags: number;
  /** Maximum length of a single campaign content tag in characters. */
  maxContentTagLength: number;
  /** Maximum grants per campaign content item. */
  maxContentGrants: number;
  /** Maximum campaign export payload size in UTF-8 bytes. */
  exportMaxBytes: number;
  /** Maximum projected records per campaign export. */
  exportMaxRecords: number;
};

export const DEFAULT_CAMPAIGN_LIMITS: CampaignLimits = {
  pageDefault: 25,
  pageMax: 100,
  maxMembers: 100,
  maxAttachedCharacters: 200,
  maxTitleLength: 200,
  maxDescriptionLength: 10_000,
  invitationExpiryDefaultDays: 7,
  invitationExpiryMaxDays: 30,
  maxContentTitleLength: 200,
  maxContentBodyLength: 100_000,
  maxContentTags: 20,
  maxContentTagLength: 50,
  maxContentGrants: 100,
  exportMaxBytes: 10 * 1024 * 1024,
  exportMaxRecords: 10_000,
};

function parseLimit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadCampaignLimits(env: NodeJS.ProcessEnv = process.env): CampaignLimits {
  const limits: CampaignLimits = {
    pageDefault: parseLimit(env, "CAMPAIGN_PAGE_DEFAULT", DEFAULT_CAMPAIGN_LIMITS.pageDefault),
    pageMax: parseLimit(env, "CAMPAIGN_PAGE_MAX", DEFAULT_CAMPAIGN_LIMITS.pageMax),
    maxMembers: parseLimit(env, "CAMPAIGN_MAX_MEMBERS", DEFAULT_CAMPAIGN_LIMITS.maxMembers),
    maxAttachedCharacters: parseLimit(
      env,
      "CAMPAIGN_MAX_ATTACHED_CHARACTERS",
      DEFAULT_CAMPAIGN_LIMITS.maxAttachedCharacters,
    ),
    maxTitleLength: parseLimit(
      env,
      "CAMPAIGN_MAX_TITLE_LENGTH",
      DEFAULT_CAMPAIGN_LIMITS.maxTitleLength,
    ),
    maxDescriptionLength: parseLimit(
      env,
      "CAMPAIGN_MAX_DESCRIPTION_LENGTH",
      DEFAULT_CAMPAIGN_LIMITS.maxDescriptionLength,
    ),
    invitationExpiryDefaultDays: parseLimit(
      env,
      "CAMPAIGN_INVITATION_EXPIRY_DEFAULT_DAYS",
      DEFAULT_CAMPAIGN_LIMITS.invitationExpiryDefaultDays,
    ),
    invitationExpiryMaxDays: parseLimit(
      env,
      "CAMPAIGN_INVITATION_EXPIRY_MAX_DAYS",
      DEFAULT_CAMPAIGN_LIMITS.invitationExpiryMaxDays,
    ),
    maxContentTitleLength: parseLimit(
      env,
      "CAMPAIGN_MAX_CONTENT_TITLE_LENGTH",
      DEFAULT_CAMPAIGN_LIMITS.maxContentTitleLength,
    ),
    maxContentBodyLength: parseLimit(
      env,
      "CAMPAIGN_MAX_CONTENT_BODY_LENGTH",
      DEFAULT_CAMPAIGN_LIMITS.maxContentBodyLength,
    ),
    maxContentTags: parseLimit(
      env,
      "CAMPAIGN_MAX_CONTENT_TAGS",
      DEFAULT_CAMPAIGN_LIMITS.maxContentTags,
    ),
    maxContentTagLength: parseLimit(
      env,
      "CAMPAIGN_MAX_CONTENT_TAG_LENGTH",
      DEFAULT_CAMPAIGN_LIMITS.maxContentTagLength,
    ),
    maxContentGrants: parseLimit(
      env,
      "CAMPAIGN_MAX_CONTENT_GRANTS",
      DEFAULT_CAMPAIGN_LIMITS.maxContentGrants,
    ),
    exportMaxBytes: parseLimit(
      env,
      "CAMPAIGN_EXPORT_MAX_BYTES",
      DEFAULT_CAMPAIGN_LIMITS.exportMaxBytes,
    ),
    exportMaxRecords: parseLimit(
      env,
      "CAMPAIGN_EXPORT_MAX_RECORDS",
      DEFAULT_CAMPAIGN_LIMITS.exportMaxRecords,
    ),
  };
  if (limits.pageDefault > limits.pageMax) {
    throw new Error("CAMPAIGN_PAGE_DEFAULT must not exceed CAMPAIGN_PAGE_MAX");
  }
  if (limits.invitationExpiryDefaultDays > limits.invitationExpiryMaxDays) {
    throw new Error(
      "CAMPAIGN_INVITATION_EXPIRY_DEFAULT_DAYS must not exceed CAMPAIGN_INVITATION_EXPIRY_MAX_DAYS",
    );
  }
  return limits;
}

export type AppConfig = {
  allowedOrigins: string[];
  authoritativeRollSecret: string;
  cookieSecure: boolean;
  databaseUrl: string;
  host: string;
  logLevel: LogLevel;
  nodeEnv: NodeEnv;
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

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const nodeEnvRaw = env.NODE_ENV ?? "development";
  if (nodeEnvRaw !== "development" && nodeEnvRaw !== "production" && nodeEnvRaw !== "test") {
    throw new Error("NODE_ENV must be development, production, or test");
  }

  const authoritativeRollSecret = env.AUTHORITATIVE_ROLL_SECRET ?? "";
  if (nodeEnvRaw !== "test" && authoritativeRollSecret.length === 0) {
    throw new Error("AUTHORITATIVE_ROLL_SECRET is required outside tests");
  }
  if (nodeEnvRaw !== "test" && Buffer.byteLength(authoritativeRollSecret, "utf8") < 32) {
    throw new Error("AUTHORITATIVE_ROLL_SECRET must be at least 32 UTF-8 bytes");
  }

  return {
    allowedOrigins,
    authoritativeRollSecret,
    cookieSecure,
    databaseUrl,
    host: env.HOST ?? "0.0.0.0",
    logLevel: logLevel as LogLevel,
    nodeEnv: nodeEnvRaw,
    port,
    sessionCookieName: env.SESSION_COOKIE_NAME ?? "session",
    sessionTtlDays,
  };
}
