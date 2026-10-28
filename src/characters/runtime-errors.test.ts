import { describe, expect, it } from "vitest";

import { isFinalizableRuntimeError, mapRuntimeError } from "./runtime-errors.js";

describe("character runtime error handling", () => {
  it.each(["exhausted", "source_unavailable"])("retains the %s push rejection as a finalizable client error", (pushReason) => {
    const error = { code: "push_unavailable", message: "This saved roll cannot be pushed.", pushReason };

    expect(mapRuntimeError(error)).toEqual({
      code: "invalid_value",
      message: error.message,
      pushReason,
    });
    expect(isFinalizableRuntimeError(error.code)).toBe(true);
  });

  it("keeps infrastructure failures transient instead of finalizing them as push rejections", () => {
    expect(mapRuntimeError({ code: "temporarily_unavailable", message: "private infrastructure detail" })).toEqual({
      code: "temporarily_unavailable",
      message: "A temporary infrastructure failure occurred.",
    });
    expect(isFinalizableRuntimeError("temporarily_unavailable")).toBe(false);
  });
});
