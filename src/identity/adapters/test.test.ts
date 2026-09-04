import { describe, expect, it } from "vitest";

import { createTestOidcClient } from "./test.js";

describe("createTestOidcClient", () => {
  const codeToClaims = new Map([
    [
      "code-ok",
      { displayName: "Ada", email: "ada@example.com", provider: "test", subject: "sub-1" },
    ],
  ]);
  const client = createTestOidcClient(codeToClaims);

  it("returns verified claims for a known code", async () => {
    await expect(
      client.verifyAuthorizationCode({ code: "code-ok", redirectUri: "http://localhost/cb" }),
    ).resolves.toEqual({
      displayName: "Ada",
      email: "ada@example.com",
      provider: "test",
      subject: "sub-1",
    });
  });

  it("rejects an unknown code", async () => {
    await expect(
      client.verifyAuthorizationCode({ code: "nope", redirectUri: "http://localhost/cb" }),
    ).rejects.toMatchObject({ code: "invalid_authorization_code" });
  });
});
