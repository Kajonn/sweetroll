export type AppErrorCode = "invalid_authorization_code" | "internal" | "session_expired";

export type AppError = {
  code: AppErrorCode;
  message: string;
};

export function createInvalidCodeError(): AppError {
  return {
    code: "invalid_authorization_code",
    message: "The authorization code is invalid or expired.",
  };
}
