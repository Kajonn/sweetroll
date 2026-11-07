# Sweetroll public API v1

**Implementation plan · 7 November 2026**

The v1 API, token lifecycle, Account controls, contract check, and quickstarts
are implemented for local testing. The current authentication configuration
uses deterministic identities, so hosted token issuance and the real-provider
Railway acceptance below remain gated on provider sign-in. The local opt-in
and usage examples are in the [API quickstart](../../api/v1.md).

## Goal and scope

A Sweetroll account holder can run a Python script or use curl to validate a declarative system document, save and publish it, then create and edit a standalone character from the exact published version. The result opens in the existing web app and can be edited there.

Use a curated JSON REST interface at `/api/v1`. Keep browser routes and cookie authentication in place. Reuse the Identity, SystemAuthoring, Characters, and SystemRuntime modules for authorization, validation, publication, revisions, and transactions. System definitions remain declarative JSON and published versions remain immutable. A new publication leaves existing characters pinned to their original version.

The owner expanded v1 to cover the full standalone authoring and setup flow. A script can start from a blank system, clone an authorized version, or import a package. It can preview, publish, export and share the system, then create a character, place or move inventory entries, and attach art. Campaign play, executing rolls, bulk mutations, delegated OAuth and SDK packages are outside this creation scope. Use a checked-in system document and a standard-library Python example for the quickstart.

## Proposed endpoint set

All paths below are relative to `/api/v1`. Read and write scopes are separate, so the quickstart token requests the scopes for both operations. Token scopes and current resource permissions must both authorize the request.

| Method and path | Purpose | Scope |
|---|---|---|
| `GET /systems` | List owned systems with cursor pagination | `systems:read` |
| `POST /systems` | Create a private draft from scratch, a clone or an import | `systems:write` |
| `GET /templates` | Discover the built-in starter versions | `systems:read` |
| `GET /systems/{systemId}` | Read the authoring workspace and current draft revision | `systems:read` |
| `POST /systems/validate` | Validate a local document and return field diagnostics without persisting it | `systems:write` |
| `PUT /systems/{systemId}/draft` | Save the complete document at the expected revision | `systems:write` |
| `POST /systems/{systemId}/preview` | Compile an expiring snapshot of the current draft | `systems:write` |
| `PUT /systems/{systemId}/sharing` | Set private, link or public access | `systems:write` |
| `GET /system-versions/{versionId}/export` | Export an owned version and its image bundle | `systems:read` |
| `GET/PUT/DELETE /systems/{systemId}/templates/{templateId}/image` | Read metadata, upload or remove draft art | `systems:read` / `systems:write` |
| `POST /systems/{systemId}/publish` | Publish an exact draft revision and return the immutable version ID | `systems:write` |
| `GET /characters/creation-versions` | List published versions available for discovery | `characters:read` |
| `GET /characters/creation-options?systemVersionId={id}` | Return entity types, initial fields, compatible slots and templates | `characters:read` |
| `GET /characters` | List the caller’s standalone characters with cursor pagination | `characters:read` |
| `POST /characters` | Create a standalone character from a published version | `characters:write` |
| `GET /characters/{characterId}` | Read the standalone sheet and its revision | `characters:read` |
| `POST /characters/{characterId}/fields/{fieldId}/set` | Update one field at the expected revision | `characters:write` |
| `POST /characters/{characterId}/duplicate` | Copy a standalone character | `characters:write` |
| `POST /characters/{characterId}/resources/{resourceId}/bump` | Change a resource by one configured step | `characters:write` |
| `POST /characters/{characterId}/entries` | Place an item, spell, or personal entry | `characters:write` |
| `PATCH/DELETE /characters/{characterId}/entries/{entryId}` | Move, edit or remove an entry | `characters:write` |
| `GET/PUT/DELETE /characters/{characterId}/portrait` | Read metadata, upload or remove the portrait | `characters:read` / `characters:write` |
| `GET/PUT/DELETE /characters/{characterId}/entries/{entryId}/image` | Read metadata, upload or remove entry art | `characters:read` / `characters:write` |
| `GET /openapi.json` | Download the published API contract | Public |

Keep token creation, listing, and revocation in the signed-in Account UI. Apply standalone-only policy inside Characters for v1 list, read, and write operations, including when a character is moved into a campaign concurrently. Use explicit public response schemas so campaign, controller, offline-recovery, and browser workspace internals are outside the v1 contract.

## Implementation sequence

For each stage, add the smallest failing tests that exercise the intended behavior, implement against the existing module boundaries, then rerun the affected HTTP and PostgreSQL integration suites.

| Stage | Work | Exit criteria |
|---|---|---|
| **1. Define the contract and mount v1** | Record the approved scope in `design_v2.md` and add an implementation plan under `docs/superpowers/plans/`. Register a separate Fastify route group at a fixed prefix in both local and combined deployments. Define explicit request and response schemas and keep the existing browser route registration. | Contract tests show the same v1 URLs in both modes and confirm that browser, campaign, and display routes are outside the v1 surface. |
| **2. Add scoped personal access tokens** | Reuse Sweetroll user identities. Add an Identity-owned token store with a digest, label, owner, scopes, expiry, and revocation state. Show the token secret only at creation. Require Bearer credentials on v1 resource routes. Keep token management behind the existing signed-in Account surface with protections for cookie-authenticated writes. Make real sign-in the dependency for hosted user-issued tokens. | Tests cover missing, invalid, expired, and revoked tokens, denied scopes, cross-account access, and browser-cookie behavior. A token cannot manage tokens. Existing resource permissions are checked on every request, including replay. |
| **3. Complete system authoring** | Reuse create, open, save, and publish. Add a no-write module operation using the existing document assessment logic. Return stable diagnostics with code, severity, and JSON Pointer. Document the distinction between document validation and publication checks that require a specific saved draft or stored assets. Publish only the requested revision and keep sharing as a separate user action. | An invalid document returns field diagnostics and creates no draft or preview snapshot. A stale save or publish cannot overwrite newer work. Retrying a committed create or publish returns the original outcome. |
| **4. Complete character creation and editing** | Reuse authorized version discovery and version lookup. Extend the runtime projection for v1 with each entity’s writable field IDs, types, defaults, and applicable constraints. Reuse the character creation and field-set commands and return the character ID and revision. | A script can discover the required fields using API responses alone. The same tests verify public discovery, known link-only version lookup, private-version denial, rejection of invalid initial values, and continued use of the original pin after a later publication. |
| **5. Publish docs and verify the hosted journey** | Generate and serve the public OpenAPI document from v1 route definitions. Include the actual draft schema, Bearer scheme, server URL, operation descriptions, representative errors, and examples. Add a curl quickstart and a runnable Python script that reads the token from an environment variable. Apply per-account request limits and stricter limits on validation and publication, effective across deployed replicas. Record token lifecycle and request IDs in audit or operational logs without logging token secrets or private payloads. | CI checks contract drift, and the quickstart runs against an isolated Railway test deployment. Production service configuration stays outside the test. |

Stages 1, 3, and 4 can be developed against deterministic test identities while real account sign-in is in progress. User-issued token acceptance and public availability depend on real sign-in and Stage 2.

## Wire behavior to settle before implementation

- **Safe retries.** Preserve the existing JSON `idempotencyKey` convention for create, publish, and field-set. Document receipt scope and retention for each command, including the behavior after expiry. A timeout retry uses the same key and identical body. A different body with the same key yields `409 idempotency_mismatch`. A revision-checked draft PUT uses a read-back to confirm its outcome if the response is lost.
- **Concurrent edits.** Use `expectedRevision` for draft saves, publishing, and character field edits. A stale revision produces a distinct `409` code and the latest revision where authorized. The client reads current state and reconciles before issuing a new mutation with a new key where required.
- **Errors and limits.** Use one JSON error envelope with a machine-readable code, human message, request ID, and structured diagnostics where applicable. Reserve `401` for missing or invalid credentials and `403` for insufficient token scope. Keep inaccessible resources indistinguishable from missing ones where existing resource policy calls for it. Document payload limits and return `429` with `Retry-After` for throttled requests.
- **Release boundary.** Treat pre-tag deployments as test environments. Change the current database baseline directly for token storage. At the first application release tag that includes the API, record the supported contract and package schemas under the existing release policy.

## Hosted acceptance

1. Confirm the isolated Railway test service’s source commit, deployment status, and readiness. Sign in with a real provider test account and issue a token for the four workflow scopes.
2. Run the quickstart with a well-formed JSON document that violates a system rule, then validate a valid system document, create a draft, save it, and publish it. Confirm validation diagnostics identify the bad field and that the validation call leaves no persisted draft.
3. Discover entity types, writable fields, slots and templates. Create a character with a non-default value, equip starting gear, move an entry, and attach a portrait. Open the character in the GUI and verify its values, inventory, portrait and actions render from the pinned system version.
4. Simulate a lost create response and replay the identical request. Confirm the original character ID returns and only one character exists. Edit the same character in the GUI, then verify a script update with the old revision returns a conflict without overwriting the GUI edit.
5. Verify a read-only token cannot write, another account cannot access private resources even with known IDs, and the next request after token revocation returns `401`. Record the tested commit, deployment, and results without including credentials.

## Repository references

- [HTTP interface and tenancy rules](https://github.com/Kajonn/sweetroll/blob/main/design_v2.md#13-http-interface-and-real-time-contract)
- [System HTTP adapter](https://github.com/Kajonn/sweetroll/blob/main/src/transport/http/systems.ts)
- [Character HTTP adapter](https://github.com/Kajonn/sweetroll/blob/main/src/transport/http/characters.ts)
- [OpenAPI and client type generation](https://github.com/Kajonn/sweetroll/blob/main/scripts/generate-system-contracts.ts)
- [Application and database release policy](https://github.com/Kajonn/sweetroll/blob/main/docs/superpowers/plans/2026-10-27-application-migration-policy.md)
