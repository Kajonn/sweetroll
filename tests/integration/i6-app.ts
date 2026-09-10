import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { createCampaignsModule, type Campaigns } from "../../src/campaigns/index.js";
import { DEFAULT_CAMPAIGN_LIMITS } from "../../src/platform/config.js";
import type { RequestContext } from "../../src/systems/authoring.js";
import {
  d20Document,
  d6SuccessPoolDocument,
} from "../../src/systems/implementation/package/fixtures/index.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/document.js";

import {
  buildI3App,
  createI3Pool,
  createI3Schema,
  dropI3Schema,
  type I3AppHandle,
} from "./i3-app.js";

export type TestActor = { actorId: string; cookie: string };

export type I6Harness = {
  app: FastifyInstance;
  pool: Pool;
  campaigns: Campaigns;
  users: { gm: TestActor; player: TestActor; other: TestActor; outsider: TestActor };
  /** A real published fixture version owned by gm. */
  versionId: string;
  /** System owning versionId. */
  systemId: string;
  /** A genuinely different real published fixture version owned by other. */
  otherVersionId: string;
  /** System owning otherVersionId. */
  otherSystemId: string;
  close(): Promise<void>;
};

export function ctxFor(actor: TestActor, requestId: string = randomUUID()): RequestContext {
  return { actorId: actor.actorId, requestId };
}

type CookieHolder = { cookie: string };

async function publishVersion(
  app: I3AppHandle,
  user: CookieHolder,
  document: SystemDocumentV1,
  opts: { name: string; semanticVersion: string },
): Promise<{ systemId: string; versionId: string }> {
  const create = await app.app.inject({
    method: "POST",
    url: "/systems",
    headers: { cookie: user.cookie },
    payload: { source: { kind: "blank", name: opts.name }, idempotencyKey: `sys-${randomUUID()}` },
  });
  if (create.statusCode !== 201) {
    throw new Error(`system create failed: ${create.statusCode} ${create.body}`);
  }
  const workspace = create.json().workspace;
  const systemId = workspace.system.systemId as string;
  const initialRevision = workspace.draft?.revision ?? 1;

  const save = await app.app.inject({
    method: "PUT",
    url: `/systems/${systemId}/draft`,
    headers: { cookie: user.cookie },
    payload: { expectedRevision: initialRevision, document },
  });
  if (save.statusCode !== 200) {
    throw new Error(`draft save failed: ${save.statusCode} ${save.body}`);
  }
  const draftRevision = save.json().workspace.draft.revision as number;

  const publish = await app.app.inject({
    method: "POST",
    url: `/systems/${systemId}/publish`,
    headers: { cookie: user.cookie },
    payload: {
      expectedRevision: draftRevision,
      semanticVersion: opts.semanticVersion,
      releaseNotes: "",
      idempotencyKey: `pub-${randomUUID()}`,
      acknowledgeBreaking: true,
    },
  });
  if (publish.statusCode !== 200) {
    throw new Error(`publish failed: ${publish.statusCode} ${publish.body}`);
  }
  return { systemId, versionId: publish.json().version.versionId as string };
}

function cookieFromSignIn(response: {
  headers: { "set-cookie"?: string | string[] };
}): string {
  const setCookie = response.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? (setCookie[0] ?? "") : (setCookie ?? "");
  return header.split(";")[0] ?? "";
}

export async function buildI6Harness(): Promise<I6Harness> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("TEST_DATABASE_URL is required for the I6 harness");
  }
  const schema = `i6_${randomUUID().replaceAll("-", "")}`;
  await createI3Schema(databaseUrl, schema);
  const pool = createI3Pool(databaseUrl, schema);
  const handle = await buildI3App({ pool });

  async function signIn(code: string): Promise<TestActor> {
    const response = await handle.app.inject({
      method: "POST",
      url: "/dev/signin",
      payload: { code, redirectUri: "http://localhost/cb" },
    });
    if (response.statusCode !== 200) {
      throw new Error(`dev/signin (${code}) failed: ${response.statusCode} ${response.body}`);
    }
    const body = response.json<{ userId: string }>();
    return { actorId: body.userId, cookie: cookieFromSignIn(response) };
  }

  const other = await signIn("code-cara");
  const outsider = await signIn("code-dan");
  const users: I6Harness["users"] = {
    gm: handle.users.ada,
    player: handle.users.bob,
    other,
    outsider,
  };

  const campaigns = createCampaignsModule({ pool, limits: DEFAULT_CAMPAIGN_LIMITS });

  const gmVersion = await publishVersion(handle, users.gm, d20Document, {
    name: "GM d20",
    semanticVersion: "1.0.0",
  });
  const otherVersion = await publishVersion(handle, users.other, d6SuccessPoolDocument, {
    name: "Other d6 pool",
    semanticVersion: "1.0.0",
  });

  return {
    app: handle.app,
    pool,
    campaigns,
    users,
    versionId: gmVersion.versionId,
    systemId: gmVersion.systemId,
    otherVersionId: otherVersion.versionId,
    otherSystemId: otherVersion.systemId,
    close: async () => {
      await handle.app.close();
      await pool.end();
      await dropI3Schema(databaseUrl, schema);
    },
  };
}
