import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { createTestOidcClient } from "../src/identity/adapters/test.js";
import { createIdentityModule } from "../src/identity/index.js";
import { d20Document } from "../src/systems/implementation/package/fixtures/d20.js";
import { createSystemPersistenceRepository } from "../src/systems/implementation/persistence/index.js";
import {
  createSystemAuthoringModule,
  type AppError,
  type AppErrorCode,
  type AuthoringWorkspace,
  type PreviewSnapshot,
  type PublishedVersion,
  type RequestContext,
  type Result,
  type SystemDocumentV1,
  type ExportedPackage,
} from "../src/systems/authoring.js";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  idempotency_mismatch: 409,
  invalid_package: 422,
  internal: 500,
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://sweetroll:sweetroll@localhost:5432/sweetroll";
const TEST_OIDC_CODE = "code-i1-demo";
const OVER_BUDGET_NODE_COUNT = 257;

type Outcome<T> =
  | { ok: true; status: 200 | 201; value: T }
  | { ok: false; status: number; error: AppError };

function toOutcome<T>(result: Result<T>): Outcome<T> {
  if (result.ok) {
    return { ok: true, status: 200, value: result.value };
  }
  return { ok: false, status: STATUS_BY_CODE[result.error.code], error: result.error };
}

function diagnosticCodes(error: AppError): string[] {
  return (error.diagnostics ?? []).map((d) => d.code);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const identity = createIdentityModule({
      oidc: createTestOidcClient(
        new Map([
          [
            TEST_OIDC_CODE,
            {
              provider: "test",
              subject: "i1-demo-user",
              email: "demo@example.com",
              displayName: "I1 Demo",
            },
          ],
        ]),
      ),
      pool,
      sessionTtlMs: 3_600_000,
    });

    const signIn = await identity.completeSignIn({
      code: TEST_OIDC_CODE,
      redirectUri: "http://localhost/cb",
      previousToken: undefined,
    });
    if (!signIn.ok) {
      throw new Error(`Identity sign-in failed: ${JSON.stringify(signIn.error)}`);
    }
    const actorId = signIn.value.userId;
    const ctx = (requestId = randomUUID()): RequestContext => ({ actorId, requestId });

    const repo = createSystemPersistenceRepository(pool);
    const authoring = createSystemAuthoringModule({ repo });

    const ts = Date.now();

    const step1 = toOutcome<AuthoringWorkspace>(
      await authoring.createDraft(ctx(), {
        source: { kind: "blank", name: "Acceptance Demo" },
        idempotencyKey: `i1-demo-create-${ts}`,
      }),
    );
    if (!step1.ok) throw new Error(`step 1: ${JSON.stringify(step1.error)}`);
    const step1Status = 201 as const;
    console.log(`STEP 1: ${step1Status} systemId=${step1.value.system.systemId}`);
    if (step1Status !== 201) throw new Error(`step 1: expected 201, got ${step1Status}`);
    const systemId = step1.value.system.systemId;

    const step2 = toOutcome<AuthoringWorkspace>(
      await authoring.saveDraft(ctx(), {
        systemId,
        expectedRevision: 1,
        document: d20Document,
      }),
    );
    if (!step2.ok) throw new Error(`step 2: ${JSON.stringify(step2.error)}`);
    console.log(`STEP 2: ${step2.status} revision=${step2.value.draft?.revision}`);
    if (step2.status !== 200) throw new Error(`step 2: expected 200, got ${step2.status}`);

    const step3 = toOutcome<PreviewSnapshot>(
      await authoring.previewDraft(ctx(), { systemId }),
    );
    if (!step3.ok) throw new Error(`step 3: ${JSON.stringify(step3.error)}`);
    console.log(`STEP 3: ${step3.status} snapshotId=${step3.value.snapshotId}`);
    if (step3.status !== 200) throw new Error(`step 3: expected 200, got ${step3.status}`);

    const step4 = toOutcome<PublishedVersion>(
      await authoring.publish(ctx(), {
        systemId,
        expectedRevision: 2,
        semanticVersion: "1.0.0",
        releaseNotes: "I1 acceptance demo",
        idempotencyKey: `i1-demo-publish-${ts}`,
        acknowledgeBreaking: false,
      }),
    );
    if (!step4.ok) throw new Error(`step 4: ${JSON.stringify(step4.error)}`);
    console.log(
      `STEP 4: ${step4.status} versionId=${step4.value.versionId} semanticVersion=${step4.value.semanticVersion}`,
    );
    if (step4.status !== 200) throw new Error(`step 4: expected 200, got ${step4.status}`);
    const versionId = step4.value.versionId;

    const step5 = toOutcome<ExportedPackage>(await authoring.exportVersion(ctx(), versionId));
    if (!step5.ok) throw new Error(`step 5: ${JSON.stringify(step5.error)}`);
    console.log(
      `STEP 5: ${step5.status} mediaType=${step5.value.mediaType} checksum=${step5.value.package.integrity.checksum}`,
    );
    if (step5.status !== 200) throw new Error(`step 5: expected 200, got ${step5.status}`);

    const step6 = toOutcome<AuthoringWorkspace>(
      await authoring.createDraft(ctx(), {
        source: { kind: "clone", versionId },
        idempotencyKey: `i1-demo-clone-${ts}`,
      }),
    );
    if (!step6.ok) throw new Error(`step 6: ${JSON.stringify(step6.error)}`);
    console.log(
      `STEP 6: 201 systemId=${step6.value.system.systemId} revision=${step6.value.draft?.revision}`,
    );
    const systemBId = step6.value.system.systemId;
    const step6Revision = step6.value.draft?.revision ?? 1;

    const overBudgetDoc: SystemDocumentV1 = structuredClone(d20Document);
    overBudgetDoc.expressions.push({
      id: "over_budget_expr",
      context: "computed",
      resultType: "number",
      source: Array.from({ length: OVER_BUDGET_NODE_COUNT }, () => "1").join("+"),
      fallback: 0,
    });

    const step7Save = toOutcome<AuthoringWorkspace>(
      await authoring.saveDraft(ctx(), {
        systemId: systemBId,
        expectedRevision: step6Revision,
        document: overBudgetDoc,
      }),
    );
    if (!step7Save.ok) throw new Error(`step 7 save: ${JSON.stringify(step7Save.error)}`);
    console.log(
      `STEP 7 (save): ${step7Save.status} revision=${step7Save.value.draft?.revision} assessmentOk=${step7Save.value.assessment.ok}`,
    );
    if (step7Save.status !== 200) throw new Error(`step 7 save: expected 200, got ${step7Save.status}`);
    const step7SaveRevision = step7Save.value.draft?.revision ?? step6Revision;

    const step7Publish = toOutcome<PublishedVersion>(
      await authoring.publish(ctx(), {
        systemId: systemBId,
        expectedRevision: step7SaveRevision,
        semanticVersion: "1.1.0",
        releaseNotes: "Over-budget attempt",
        idempotencyKey: `i1-demo-publish-ob-${ts}`,
        acknowledgeBreaking: false,
      }),
    );
    if (step7Publish.ok) throw new Error("step 7 publish: expected failure");
    console.log(
      `STEP 7 (publish): ${step7Publish.status} diagnostics=${JSON.stringify(diagnosticCodes(step7Publish.error))}`,
    );
    if (step7Publish.status !== 422) {
      throw new Error(`step 7 publish: expected 422, got ${step7Publish.status}`);
    }
    if (!diagnosticCodes(step7Publish.error).includes("limit_exceeded")) {
      throw new Error(
        `step 7 publish: expected limit_exceeded diagnostic, got ${JSON.stringify(step7Publish.error.diagnostics)}`,
      );
    }

    const breakingDoc: SystemDocumentV1 = structuredClone(d20Document);
    breakingDoc.entities[0].fields = breakingDoc.entities[0].fields.filter(
      (field) => field.id !== "proficient",
    );

    const step8Save = toOutcome<AuthoringWorkspace>(
      await authoring.saveDraft(ctx(), {
        systemId,
        expectedRevision: 2,
        document: breakingDoc,
      }),
    );
    if (!step8Save.ok) throw new Error(`step 8 save: ${JSON.stringify(step8Save.error)}`);
    console.log(`STEP 8 (save): ${step8Save.status} revision=${step8Save.value.draft?.revision}`);
    if (step8Save.status !== 200) throw new Error(`step 8 save: expected 200, got ${step8Save.status}`);
    const step8SaveRevision = step8Save.value.draft?.revision ?? 3;

    const step8Publish = toOutcome<PublishedVersion>(
      await authoring.publish(ctx(), {
        systemId,
        expectedRevision: step8SaveRevision,
        semanticVersion: "1.1.0",
        releaseNotes: "Breaking change attempt",
        idempotencyKey: `i1-demo-publish-bc-${ts}`,
        acknowledgeBreaking: false,
      }),
    );
    if (step8Publish.ok) throw new Error("step 8 publish: expected failure");
    console.log(
      `STEP 8 (publish): ${step8Publish.status} diagnostics=${JSON.stringify(diagnosticCodes(step8Publish.error))}`,
    );
    if (step8Publish.status !== 422) {
      throw new Error(`step 8 publish: expected 422, got ${step8Publish.status}`);
    }
    if (!diagnosticCodes(step8Publish.error).includes("breaking_removed_definition")) {
      throw new Error(
        `step 8 publish: expected breaking_removed_definition diagnostic, got ${JSON.stringify(step8Publish.error.diagnostics)}`,
      );
    }

    const finalExport = toOutcome<ExportedPackage>(await authoring.exportVersion(ctx(), versionId));
    if (!finalExport.ok) throw new Error(`step 9 (unchanged v1.0.0): ${JSON.stringify(finalExport.error)}`);
    console.log(
      `STEP 9 (unchanged v1.0.0 export): ${finalExport.status} checksum=${finalExport.value.package.integrity.checksum}`,
    );
    if (finalExport.status !== 200) {
      throw new Error(`step 9: expected 200, got ${finalExport.status}`);
    }

    console.log("ALL 8 STEPS PASSED");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("DEMO FAILED:", err);
  process.exit(1);
});
