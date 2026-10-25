import { test, expect } from "@playwright/test";
import { signIn, workspace, pushDocument, publish, createCharacter, json, key, cleanup, resultOf, assertChild } from "../fixtures/configurablePush.js";

test("locked, empty and successful saved pools explain why pushing is unavailable", async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page);
  const document = pushDocument(), original = document.actions.find(a => a.kind === "roll")!;
  if (original.kind !== "roll") throw Error("fixture");
  document.actions = [
    { ...structuredClone(original), id: "locked_pool", label: "Locked Pool", pushPolicy: { ...original.pushPolicy!, groups: [{ groupId: "attribute", lockedFaces: [1, 2, 3, 4, 5, 6], reportedFaces: [] }] } },
    { ...structuredClone(original), id: "empty_pool", label: "Empty Pool", pushPolicy: { ...original.pushPolicy!, groups: [{ groupId: "gear", lockedFaces: [], reportedFaces: [] }] } },
    { ...structuredClone(original), id: "successful_pool", label: "Successful Pool", pushPolicy: { ...original.pushPolicy!, allowOnSuccess: false, successThreshold: 0 } },
  ];
  for (const action of document.actions) {
    if (action.kind !== "roll") continue;
    const expression = structuredClone(document.expressions.find(e => e.id === original.expressionId)!);
    expression.id = `${action.id}_expression`;
    for (const input of action.inputs) {
      const previous = input.id;
      input.id = `${action.id}_${previous}`;
      expression.source = expression.source.replaceAll(`inputs.${previous}`, `inputs.${input.id}`);
    }
    action.expressionId = expression.id;
    document.expressions.push(expression);
  }
  document.expressions = document.expressions.filter(expression => expression.id !== original.expressionId);
  for (const sheet of document.sheets) for (const section of sheet.sections) section.elements = section.elements.filter(element => element.kind !== "action");
  document.sheets[0]!.sections[0]!.elements.push(...document.actions.map((action) => ({ kind: "action" as const, id: `button_${action.id}`, actionId: action.id })));
  const system = await workspace(page.request, document), ids: string[] = [], outcomes: unknown[] = [];
  try {
    const character = await createCharacter(page.request, await publish(page.request, system.id)), id = character.characterId;
    ids.push(id);
    await page.goto(`/characters/${id}`);
    for (const [action, reason] of [["locked_pool", "no_eligible_dice"], ["empty_pool", "no_eligible_dice"], ["successful_pool", "successful_roll"]] as const) {
      const label = document.actions.find(a => a.id === action)!.label;
      const root = (await resultOf(page, () => page.getByRole("button", { name: label, exact: true }).click(), `/actions/${action}`)).result.roll;
      const options = (await json(page.request, "GET", `/api/characters/${id}/rolls/${root.push.rollId}/push-options`)).options;
      expect(options).toMatchObject({ canPush: false, reason, eligibleDiceIds: [] });
      await expect(page.getByTestId("push-result").getByRole("button", { name: "Push saved roll" })).toBeDisabled();
      const denied = await page.request.post(`/api/characters/${id}/rolls/${root.push.rollId}/push`, { data: { expectedRevision: character.revision, idempotencyKey: key() } });
      expect(denied.status()).toBe(422);
      expect((await denied.json()).error.pushReason).toBe(reason);
      outcomes.push({ action, reason, root });
    }
  } finally {
    const cleaned = await cleanup(page.request, system.id, ids);
    await info.attach("push-edge-evidence", { body: JSON.stringify({ systemId: system.id, outcomes, cleanup: cleaned }, null, 2), contentType: "application/json" });
  }
});

test("saved item pools follow source removal, exact restoration and archive/recovery", async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page);
  const system = await workspace(page.request), ids: string[] = [];
  const evidence: Record<string, unknown> = { systemId: system.id };
  try {
    const versionId = await publish(page.request, system.id);
    const character = await createCharacter(page.request, versionId);
    let id = character.characterId;
    ids.push(id);
    const current = async () => (await json(page.request, "GET", `/api/characters/${id}`)).character;
    const entry = { entryId: key(), slotId: "gear_slot", templateId: "pool_tool", values: {}, quantity: 1 };
    const add = () => current().then(c => json(page.request, "POST", `/api/characters/${id}/entries`, { entry, expectedRevision: c.revision, idempotencyKey: key() }));
    await add();
    await page.goto(`/characters/${id}`);
    let root = (await resultOf(page, () => page.getByRole("button", { name: "Tool Pool", exact: true }).click(), "/actions/tool_pool")).result.roll;
    const options = async () => (await json(page.request, "GET", `/api/characters/${id}/rolls/${root.push.rollId}/push-options`)).options;
    const showHistory = async (archived = false) => {
      await page.reload();
      await expect(page.getByRole("button", { name: archived ? "Recover" : "Archive", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      return page.getByRole("dialog", { name: "Activity" }).getByTestId("push-result").filter({ hasText: "Original roll" }).first();
    };
    await json(page.request, "DELETE", `/api/characters/${id}/entries/${entry.entryId}`, { expectedRevision: (await current()).revision, idempotencyKey: key() });
    expect(await options()).toMatchObject({ canPush: false, reason: "source_unavailable" });
    let panel = await showHistory();
    await expect(panel.getByRole("button", { name: "Push saved roll" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await add();
    expect(await options()).toMatchObject({ canPush: true, reason: null });
    await json(page.request, "PATCH", `/api/characters/${id}`, { command: "archive", expectedRevision: (await current()).revision, idempotencyKey: key() });
    expect(await options()).toMatchObject({ canPush: false, reason: "archived" });
    panel = await showHistory(true);
    await expect(panel.getByRole("button", { name: "Push saved roll" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await json(page.request, "PATCH", `/api/characters/${id}`, { command: "recover", expectedRevision: (await current()).revision, idempotencyKey: key() });
    expect((await options()).canPush).toBe(true);
    panel = await showHistory();
    const itemRoot = root;
    const itemChild = (await resultOf(page, () => panel.getByRole("button", { name: "Push saved roll" }).click(), "/push")).result.roll;
    assertChild(itemRoot, itemChild);
    Object.assign(evidence, { characterIds: ids, entryId: entry.entryId, versionId, itemRoot, itemChild, transitions: ["remove", "exact restore", "archive", "recover"] });
  } finally {
    evidence.cleanup = await cleanup(page.request, system.id, ids);
    await info.attach("push-transition-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  }
});

test("a saved entity pool rejects changed rules and resumes after exact version rollback", async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page);
  const system = await workspace(page.request), ids: string[] = [];
  const evidence: Record<string, unknown> = { systemId: system.id };
  try {
    const versionId = await publish(page.request, system.id);
    const character = await createCharacter(page.request, versionId), id = character.characterId;
    ids.push(id);
    const current = async () => (await json(page.request, "GET", `/api/characters/${id}`)).character;
    await page.goto(`/characters/${id}`);
    const root = (await resultOf(page, () => page.getByRole("button", { name: "Test Pool", exact: true }).click(), "/actions/test_pool")).result.roll;
    const options = async () => (await json(page.request, "GET", `/api/characters/${id}/rolls/${root.push.rollId}/push-options`)).options;
    const opened = (await json(page.request, "GET", `/api/systems/${system.id}`)).workspace;
    const nextVersion = (await json(page.request, "POST", `/api/systems/${system.id}/publish`, { expectedRevision: opened.draft.revision, semanticVersion: "1.0.1", releaseNotes: "Version transition acceptance", acknowledgeBreaking: true, idempotencyKey: key() })).version.versionId;
    const preview = (await json(page.request, "POST", `/api/characters/${id}/migration-previews`, { targetVersionId: nextVersion })).preview;
    const committed = await json(page.request, "POST", `/api/characters/${id}/migrations/${preview.previewId}/commit`, { expectedRevision: (await current()).revision, idempotencyKey: key() });
    const migrationId = committed.result.character.reconciliation.commandExecutionId;
    expect(migrationId).toMatch(/[0-9a-f-]{36}/);
    expect(await options()).toMatchObject({ canPush: false, reason: "rules_changed" });
    const rejected = await page.request.post(`/api/characters/${id}/rolls/${root.push.rollId}/push`, { data: { expectedRevision: (await current()).revision, idempotencyKey: key() } });
    expect(rejected.status()).toBe(422);
    expect((await rejected.json()).error.pushReason).toBe("rules_changed");
    await json(page.request, "POST", `/api/characters/${id}/migrations/${migrationId}/rollback`, { idempotencyKey: key() });
    expect((await current()).systemVersionId).toBe(versionId);
    expect((await options()).canPush).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Activity" }).getByTestId("push-result").filter({ hasText: "Original roll" }).first();
    await expect(panel.getByRole("button", { name: "Push saved roll" })).toBeEnabled();
    const child = (await resultOf(page, () => panel.getByRole("button", { name: "Push saved roll" }).click(), "/push")).result.roll;
    assertChild(root, child);
    Object.assign(evidence, { characterId: id, versionId, nextVersion, migrationId, root, child, oldPoolReason: "rules_changed" });
  } finally {
    evidence.cleanup = await cleanup(page.request, system.id, ids);
    await info.attach("push-version-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  }
});

test("two authorized GM actors consume one parent once and preserve exact replay and shared history", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  await signIn(page);
  const system = await workspace(page.request), ids: string[] = [];
  const peer = await browser.newContext({ baseURL: new URL(page.url()).origin, ignoreHTTPSErrors: true });
  let campaignId: string | undefined;
  const evidence: Record<string, unknown> = { systemId: system.id };
  try {
    const b = await peer.newPage(), peerId = await signIn(b, "code-test-b");
    const versionId = await publish(page.request, system.id);
    await json(page.request, "PATCH", `/api/systems/${system.id}`, { access: "public" });
    campaignId = (await json(page.request, "POST", "/api/campaigns", { systemVersionId: versionId, title: `Push Race ${key()}`, idempotencyKey: key() })).campaign.campaignId;
    const revision = async () => (await json(page.request, "GET", `/api/campaigns/${campaignId}`)).campaign.revision;
    const invitation = (await json(page.request, "POST", `/api/campaigns/${campaignId}/invitations`, { intendedRole: "co_gm", expectedCampaignRevision: await revision(), idempotencyKey: key() })).invitation;
    const review = (await json(b.request, "POST", "/api/invitations/review", { token: invitation.token })).review;
    await json(b.request, "POST", "/api/invitations/accept", { campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision, reviewedAccessRevision: review.accessRevision, idempotencyKey: key() });
    const character = (await json(page.request, "POST", `/api/campaigns/${campaignId}/characters`, { name: `Concurrent Push ${key()}`, entityDefinitionId: "character", controllerUserIds: [peerId], expectedCampaignRevision: await revision(), idempotencyKey: key() })).character;
    const id = character.characterId; ids.push(id);
    await page.goto(`/characters/${id}`);
    const root = (await resultOf(page, () => page.getByRole("button", { name: "Test Pool", exact: true }).click(), "/actions/test_pool")).result.roll;
    const path = `/api/characters/${id}/rolls/${root.push.rollId}/push`;
    const bodies = [0, 1].map(() => ({ expectedRevision: character.revision, idempotencyKey: key() }));
    const requests = [page.request, b.request];
    const responses = await Promise.all(requests.map((request, i) => request.post(path, { data: bodies[i] })));
    expect(responses.map(r => r.status()).sort()).toEqual([200, 409]);
    const winner = responses.findIndex(r => r.status() === 200), child = (await responses[winner]!.json()).result.roll;
    assertChild(root, child);
    const replay = await requests[winner]!.post(path, { data: bodies[winner] });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).result.roll).toEqual(child);
    const history = await json(page.request, "GET", `/api/characters/${id}/activity`);
    expect(history.events.filter((e: any) => e.roll?.push?.parentRollId === root.push.rollId)).toHaveLength(1);
    await b.goto(`/characters/${id}`);
    await b.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(b.getByRole("dialog", { name: "Activity" }).getByTestId("push-result")).toHaveCount(2);
    Object.assign(evidence, { campaignId, characterId: id, root, child, concurrentStatuses: responses.map(r => r.status()), exactReplay: true, acceptedChildren: 1 });
  } finally {
    await peer.close();
    evidence.cleanup = await cleanup(page.request, system.id, ids, campaignId);
    await info.attach("push-race-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  }
});

test("adoption and return invalidate saved pools from earlier placement generations", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  await signIn(page);
  const system = await workspace(page.request), ids: string[] = [];
  const peer = await browser.newContext({ baseURL: new URL(page.url()).origin, ignoreHTTPSErrors: true });
  let campaignId: string | undefined;
  let personalId: string | undefined;
  const evidence: Record<string, unknown> = { systemId: system.id };
  try {
    const b = await peer.newPage(), peerId = await signIn(b, "code-test-b");
    const versionId = await publish(page.request, system.id);
    await json(page.request, "PATCH", `/api/systems/${system.id}`, { access: "public" });
    campaignId = (await json(page.request, "POST", "/api/campaigns", { systemVersionId: versionId, title: `Push Placement ${key()}`, idempotencyKey: key() })).campaign.campaignId;
    const revision = async () => (await json(page.request, "GET", `/api/campaigns/${campaignId}`)).campaign.revision;
    const invitation = (await json(page.request, "POST", `/api/campaigns/${campaignId}/invitations`, { intendedRole: "player", expectedCampaignRevision: await revision(), idempotencyKey: key() })).invitation;
    const review = (await json(b.request, "POST", "/api/invitations/review", { token: invitation.token })).review;
    await json(b.request, "POST", "/api/invitations/accept", { campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision, reviewedAccessRevision: review.accessRevision, idempotencyKey: key() });
    const character = await createCharacter(b.request, versionId), id = character.characterId;
    personalId = id;
    await b.goto(`/characters/${id}`);
    const personal = (await resultOf(b, () => b.getByRole("button", { name: "Test Pool", exact: true }).click(), "/actions/test_pool")).result.roll;
    const adopted = (await json(b.request, "POST", `/api/campaigns/${campaignId}/characters/${id}/adopt`, { expectedCampaignRevision: await revision(), expectedCharacterRevision: character.revision, acknowledgedDisclosure: true, idempotencyKey: key() })).character;
    expect(adopted.placementGeneration).toBeGreaterThan(character.placementGeneration);
    expect((await b.request.get(`/api/characters/${id}/rolls/${personal.push.rollId}/push-options`)).status()).toBe(404);
    await b.reload();
    await expect(b.getByRole("button", { name: "Archive", exact: true })).toBeEnabled();
    expect((await b.request.post(`/api/characters/${id}/rolls/${personal.push.rollId}/push`, { data: { expectedRevision: adopted.revision, idempotencyKey: key() } })).status()).toBe(404);
    const attached = (await resultOf(b, () => b.getByRole("button", { name: "Test Pool", exact: true }).click(), "/actions/test_pool")).result.roll;
    await json(page.request, "DELETE", `/api/campaigns/${campaignId}/members/${peerId}`, { expectedCampaignRevision: await revision(), idempotencyKey: key() });
    const returned = (await json(b.request, "GET", `/api/characters/${id}`)).character;
    expect(returned.campaignId).toBeNull();
    expect(returned.placementGeneration).toBeGreaterThan(adopted.placementGeneration);
    for (const root of [personal, attached]) expect((await b.request.get(`/api/characters/${id}/rolls/${root.push.rollId}/push-options`)).status()).toBe(404);
    expect((await page.request.get(`/api/characters/${id}`)).status()).toBe(404);
    await b.reload();
    await expect(b.getByRole("button", { name: "Archive", exact: true })).toBeEnabled();
    await expect(b.getByTestId("push-result")).toHaveCount(0);
    const fresh = (await resultOf(b, () => b.getByRole("button", { name: "Test Pool", exact: true }).click(), "/actions/test_pool")).result.roll;
    await expect(b.getByRole("button", { name: "Push saved roll" })).toBeEnabled();
    const child = (await resultOf(b, () => b.getByRole("button", { name: "Push saved roll" }).click(), "/push")).result.roll;
    assertChild(fresh, child);
    await json(b.request, "PATCH", `/api/characters/${id}`, { command: "archive", expectedRevision: returned.revision, idempotencyKey: key() });
    Object.assign(evidence, { campaignId, characterId: id, generations: [character.placementGeneration, adopted.placementGeneration, returned.placementGeneration], personal, attached, fresh, child, formerGmDenied: true });
  } finally {
    if (personalId) {
      const current = (await json(peer.request, "GET", `/api/characters/${personalId}`)).character;
      if (current.lifecycle !== "archived") await json(peer.request, "PATCH", `/api/characters/${personalId}`, { command: "archive", expectedRevision: current.revision, idempotencyKey: key() });
      expect((await json(peer.request, "GET", `/api/characters/${personalId}`)).character.lifecycle).toBe("archived");
    }
    await peer.close();
    evidence.cleanup = await cleanup(page.request, system.id, ids, campaignId);
    await info.attach("push-placement-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  }
});
