import { test, expect } from "@playwright/test";
import {
  signIn,
  workspace,
  publish,
  createCharacter,
  cleanup,
  resultOf,
  assertChild,
  json,
  cachedPushState,
} from "../fixtures/configurablePush.js";
import { expectOfflineAvailable } from "./test-auth.js";

test("a committed but unseen push replays the frozen request after offline reload and retains its child offline", async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  const actorId = await signIn(page),
    system = await workspace(page.request),
    ids: string[] = [];
  const evidence: Record<string, unknown> = { systemId: system.id };
  try {
    const character = await createCharacter(
        page.request,
        await publish(page.request, system.id),
      ),
      id = character.characterId;
    ids.push(id);
    evidence.characterId = id;
    await page.goto(`/characters/${id}`);
    await expectOfflineAvailable(page);
    const root = (
      await resultOf(
        page,
        () =>
          page.getByRole("button", { name: "Test Pool", exact: true }).click(),
        "/actions/test_pool",
      )
    ).result.roll;
    const bodies: unknown[] = [];
    page.on("request", (r) => {
      if (
        r.method() === "POST" &&
        r.url().endsWith(`/rolls/${root.push.rollId}/push`)
      )
        bodies.push(r.postDataJSON());
    });
    let committed!: () => void;
    const applied = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let child: any = null,
      first = true;
    const pattern = `**/api/characters/${id}/rolls/${root.push.rollId}/push`;
    await page.route(pattern, async (route) => {
      if (first) {
        first = false;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        child = (await response.json()).result.roll;
        await context.setOffline(true);
        await route.abort("failed");
        committed();
      } else await route.abort("failed");
    });
    await expect(
      page.getByRole("button", { name: "Push saved roll" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Push saved roll" }).click();
    await applied;
    assertChild(root, child);
    await expect
      .poll(
        async () => (await cachedPushState(page, actorId, id)).attempts.length,
      )
      .toBe(1);
    const frozen = (await cachedPushState(page, actorId, id)).attempts;
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Push saved roll" }),
    ).toBeDisabled();
    expect((await cachedPushState(page, actorId, id)).attempts).toEqual(frozen);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await page.unroute(pattern);
    await context.setOffline(false);
    await expect(page.getByTestId("push-result")).toHaveAttribute(
      "data-roll-id",
      child.push.rollId,
    );
    await expect
      .poll(
        async () => (await cachedPushState(page, actorId, id)).attempts.length,
      )
      .toBe(0);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    const history = await json(
      page.request,
      "GET",
      `/api/characters/${id}/activity`,
    );
    expect(history.events.filter((e: any) => e.roll?.push)).toHaveLength(2);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId("push-result")).toHaveAttribute(
      "data-roll-id",
      child.push.rollId,
    );
    await expect(
      page.getByRole("button", { name: "Push saved roll" }),
    ).toBeDisabled();
    expect((await cachedPushState(page, actorId, id)).attempts).toEqual([]);
    Object.assign(evidence, {
      root,
      child,
      identicalRequestCount: bodies.length,
      historyRolls: 2,
      offlineReload: true,
    });
  } finally {
    await context.setOffline(false);
    evidence.cleanup = await cleanup(page.request, system.id, ids);
    await info.attach("push-recovery-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
  }
});
