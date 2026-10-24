import { test, expect } from "@playwright/test";
import {
  signIn,
  workspace,
  publish,
  json,
  key,
  cleanup,
  resultOf,
  assertChild,
  cachedPushState,
} from "../fixtures/configurablePush.js";

test("GM board and co-GM pushes inherit the original audience and erase denied cached results after demotion", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180000);
  await signIn(page);
  const system = await workspace(page.request),
    ids: string[] = [];
  let campaignId: string | undefined;
  const peer = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    ignoreHTTPSErrors: true,
  });
  const b = await peer.newPage();
  const peerId = await signIn(b, "code-test-b");
  const evidence: Record<string, unknown> = { systemId: system.id };
  try {
    const versionId = await publish(page.request, system.id);
    await json(page.request, "PATCH", `/api/systems/${system.id}`, {
      access: "public",
    });
    campaignId = (
      await json(page.request, "POST", "/api/campaigns", {
        systemVersionId: versionId,
        title: `Push Campaign ${key()}`,
        description: "Push audience acceptance",
        idempotencyKey: key(),
      })
    ).campaign.campaignId;
    const revision = async () =>
      (await json(page.request, "GET", `/api/campaigns/${campaignId}`)).campaign
        .revision;
    const invitation = (
      await json(
        page.request,
        "POST",
        `/api/campaigns/${campaignId}/invitations`,
        {
          intendedRole: "co_gm",
          expectedCampaignRevision: await revision(),
          idempotencyKey: key(),
        },
      )
    ).invitation;
    const review = (
      await json(b.request, "POST", "/api/invitations/review", {
        token: invitation.token,
      })
    ).review;
    await json(b.request, "POST", "/api/invitations/accept", {
      campaignId,
      token: invitation.token,
      expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
      idempotencyKey: key(),
    });
    const character = (
      await json(
        page.request,
        "POST",
        `/api/campaigns/${campaignId}/characters`,
        {
          name: `Shared Push ${key()}`,
          entityDefinitionId: "character",
          controllerUserIds: [peerId],
          expectedCampaignRevision: await revision(),
          idempotencyKey: key(),
        },
      )
    ).character;
    const id = character.characterId;
    ids.push(id);
    Object.assign(evidence, { campaignId, characterId: id });
    await page.goto(`/campaigns/${campaignId}`);
    await page.getByRole("tab", { name: "Session", exact: true }).click();
    await page
      .getByRole("button", { name: `Open ${character.name}`, exact: true })
      .click();
    await page
      .getByLabel("Roll audience", { exact: true })
      .selectOption("gm_only");
    const root = (
      await resultOf(
        page,
        () =>
          page
            .getByRole("button", { name: "Roll Test Pool", exact: true })
            .click(),
        "/actions/test_pool",
      )
    ).result.roll;
    await b.goto(`/characters/${id}`);
    await b.getByRole("button", { name: "Activity", exact: true }).click();
    const activity = b.getByRole("dialog", { name: "Activity" });
    await expect(
      activity.getByRole("button", { name: "Push saved roll" }),
    ).toBeEnabled();
    const pushedResponse = b.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/push"),
    );
    await activity.getByRole("button", { name: "Push saved roll" }).click();
    const response = await pushedResponse;
    expect(response.status()).toBe(200);
    const requestBody = response.request().postDataJSON(),
      child = (await response.json()).result.roll;
    assertChild(root, child);
    expect(child.audience).toBe("gm_only");
    await b.keyboard.press("Escape");
    await expect(b.getByTestId("push-result")).toHaveAttribute(
      "data-roll-id",
      child.push.rollId,
    );
    await b.goto(`/campaigns/${campaignId}`);
    await b.getByRole("tab", { name: "Session", exact: true }).click();
    await b
      .getByRole("button", { name: `Open ${character.name}`, exact: true })
      .click();
    await expect(
      b.getByRole("button", { name: "Push saved roll" }),
    ).toBeEnabled();
    const next = (
      await resultOf(
        b,
        () => b.getByRole("button", { name: "Push saved roll" }).click(),
        "/push",
      )
    ).result.roll;
    assertChild(child, next);
    await expect(b.getByTestId("push-result")).toHaveAttribute(
      "data-roll-id",
      next.push.rollId,
    );
    const exported = (
      await json(page.request, "POST", `/api/campaigns/${campaignId}/exports`, {
        idempotencyKey: key(),
      })
    ).export;
    expect(
      exported.rolls.find((r: any) => r.rollId === next.push.rollId).push,
    ).toEqual(next.push);
    await json(
      page.request,
      "PATCH",
      `/api/campaigns/${campaignId}/members/${peerId}`,
      {
        role: "player",
        expectedCampaignRevision: await revision(),
        idempotencyKey: key(),
      },
    );
    expect((await b.request.get(`/api/characters/${id}`)).status()).toBe(200);
    expect(
      (
        await b.request.get(`/api/characters/${id}/rolls/${next.push.rollId}`)
      ).status(),
    ).toBe(404);
    expect(
      (
        await b.request.post(
          `/api/characters/${id}/rolls/${root.push.rollId}/push`,
          { data: requestBody },
        )
      ).status(),
    ).toBe(404);
    await b.goto(`/characters/${id}`);
    await expect
      .poll(async () => (await cachedPushState(b, peerId, id)).rollId)
      .toBeNull();
    await expect(b.getByTestId("push-result")).toHaveCount(0);
    // Production worker variant additionally proves the denial survives an offline reload.
    const worker = await b.evaluate(() =>
      Boolean(navigator.serviceWorker?.controller),
    );
    if (worker) {
      await peer.setOffline(true);
      await b.reload();
      await expect(b.getByTestId("push-result")).toHaveCount(0);
      await peer.setOffline(false);
    }
    Object.assign(evidence, {
      root,
      child,
      next,
      exportPreserved: true,
      demotedControllerStillReadsSheet: true,
      privateRollDenied: true,
      offlineDenialChecked: worker,
    });
  } finally {
    await peer.setOffline(false);
    evidence.cleanup = await cleanup(page.request, system.id, ids, campaignId);
    await peer.close();
    await info.attach("campaign-push-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
  }
});
