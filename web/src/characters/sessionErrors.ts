import { t } from "../i18n/index.js";
import type { BlockingError, BlockingErrorKind, BlockingErrorReason, SessionCommandError } from "./session.js";

/**
 * V3: the one place that turns a character session error code into text.
 * The session reports `kind` (plus a `reason` where one kind covers
 * situations that need different text); every surface (the character route,
 * the conflict review and the campaign session board) renders it through
 * these i18n keys. The session's `diagnostic` is never rendered.
 */
type ErrorCode = { kind: BlockingErrorKind; reason?: BlockingErrorReason | undefined };

const REASON_KEYS: Record<BlockingErrorReason, string> = {
  "request-in-flight": "character.error.conflictInFlight",
  "newer-version": "character.error.conflictNewerVersion",
  "roll-preparation": "character.error.rollPreparation",
  "unknown-outcome": "character.error.expiredAttemptUnknownOutcome",
  "review-base-unavailable": "character.error.reviewBaseUnavailable",
};

const KIND_KEYS: Record<BlockingErrorKind, string> = {
  conflict: "character.error.conflict",
  invalid: "character.error.invalid",
  reauthenticate: "character.error.reauthenticate",
  "storage-error": "character.detail.storageUnavailable",
  purged: "character.sync.purged",
  "expired-attempt": "character.error.expiredAttempt",
  protocol: "character.error.protocol",
  "not-found": "character.error.notFound",
  "network-unavailable": "character.error.refreshFailed",
};

/** The i18n key for a session error code. */
export function sessionErrorKey(code: ErrorCode): string {
  return code.reason !== undefined ? REASON_KEYS[code.reason] : KIND_KEYS[code.kind];
}

/**
 * The text for a session error: the server's own message when the error
 * carries one (a rejected value or a server conflict, server data shown as
 * before V3), else the translated text for its code.
 */
export function sessionErrorText(error: ErrorCode & { serverMessage?: string | undefined }): string {
  if (error.serverMessage !== undefined && error.serverMessage !== "") return error.serverMessage;
  return t(sessionErrorKey(error));
}

/**
 * Whether the character route shows the error as its own alert next to a
 * shown sheet. Conditions with another surface do not: storage (the
 * read-only status and sync line; it is not an `error` at all), `purged` (the
 * "unavailable" text and sync line) and the review kinds (the review panel).
 * Without a sheet the route shows only the "unavailable" text. A `not-found`
 * while the sheet is still shown has no such text, so it keeps the alert.
 */
export function routeShowsErrorAlert(error: BlockingError): boolean {
  switch (error.kind) {
    case "reauthenticate":
    case "network-unavailable":
    case "protocol":
    case "not-found":
      return true;
    default:
      return false;
  }
}

/**
 * The text for a refused or failed command. A command the session refused
 * because of its open error or storage failure is translated from that code;
 * any other failure keeps its message, as before V3.
 */
export function describeCommandFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && (error as SessionCommandError).blocked === true &&
    typeof (error as SessionCommandError).kind === "string" ? (error as SessionCommandError & ErrorCode) : null;
  const message = code !== null ? sessionErrorText(code) : error instanceof Error ? error.message : String(error);
  return t("character.command.failed", { message });
}
