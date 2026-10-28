import type { CharacterError } from "./index.js";

export function mapRuntimeError(error: {
  code: string;
  message: string;
  definitionId?: string;
  actionDiagnostics?: import("../systems/runtime.js").ActionEvaluationDiagnostic[];
}): CharacterError {
  switch (error.code) {
    case "not_found":
      return { code: "not_found", message: "The published version or entity definition does not exist." };
    case "action_evaluation_failed":
      return { code: "invalid_value", message: error.message, ...(error.actionDiagnostics === undefined ? {} : { actionDiagnostics: error.actionDiagnostics }) };
    case "bad_request":
    case "invalid_state":
    case "unsupported_field_value":
    case "budget_exceeded":
    case "invalid_package":
      return { code: "invalid_value", message: error.message };
    default:
      return { code: "temporarily_unavailable", message: "A temporary infrastructure failure occurred." };
  }
}

// Only these runtime error codes are stable/deterministic for the same input
// and safe to permanently finalize on the idempotency key (standalone path).
const STABLE_RUNTIME_ERROR_CODES = new Set([
  "action_evaluation_failed",
  "not_found",
  "bad_request",
  "invalid_state",
  "unsupported_field_value",
  "budget_exceeded",
  "invalid_package",
]);

export function isFinalizableRuntimeError(code: string): boolean {
  return STABLE_RUNTIME_ERROR_CODES.has(code);
}
