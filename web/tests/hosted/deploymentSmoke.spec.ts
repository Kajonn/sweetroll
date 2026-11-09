import { expect, test } from "@playwright/test";

test("acceptance GUI signs in and signs out", async ({ page }) => {
  await page.goto("/characters");
  const welcome = page.getByRole("button", { name: "Continue", exact: true });
  const signin = page.getByRole("button", { name: "Sign in for acceptance testing", exact: true });
  await expect(welcome.or(signin)).toBeVisible();
  if (await welcome.isVisible()) await welcome.click();
  await signin.click();

  const signout = page.getByRole("button", { name: "Sign out", exact: true });
  await expect(signout).toBeVisible();
  expect(await (await page.request.get("/api/me")).json()).toMatchObject({ state: "authenticated" });
  page.once("dialog", (dialog) => dialog.accept());
  await signout.click();
  await expect(signin).toBeVisible();
  expect(await (await page.request.get("/api/me")).json()).toMatchObject({ state: "anonymous" });
});
