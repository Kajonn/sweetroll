# Sweetroll public API v1

**Implementation plan · 7 November 2026 · Completion scope added 7 November 2026**

**Status:** Part A, the standalone creation scope, is implemented for local
testing. It covers the v1 routes, token lifecycle, Account controls, contract
check and quickstarts. Hosted token issuance and the real-provider Railway
acceptance remain gated on provider sign-in. The local opt-in and usage
examples are in the [API quickstart](../../api/v1.md).

Part B is approved by the owner (2026-11-07) and not yet implemented. It
completes v1 so that a script can do everything the signed-in web app can do,
including campaigns. The exclusions are listed under "Outside v1". Part B
supersedes the earlier exclusion of campaign play and roll execution.

## Goal

An account holder can automate any Sweetroll workflow with a personal access
token, curl or a short Python script, with the same permissions as in the web
app. Examples:

- author and publish a system;
- create a character and play it, including rolls and pushes;
- run a campaign: invite players, place characters, publish content, item
  templates and proposals;
- build scenes with fog and tokens and pair a table display.

Results open in the existing web app, and work done in the app is visible to
the API.

Keep the curated JSON REST interface at `/api/v1` and the browser routes with
cookie authentication. The API reuses the Identity, SystemAuthoring,
Characters, SystemRuntime and Campaigns modules for authorization, validation,
revisions, idempotency and transactions. It never widens what the caller could
read or change in the browser. Published system versions remain immutable,
and characters and campaigns stay pinned to their versions.

## Part A — delivered creation scope

All paths are relative to `/api/v1`. A request needs both the token scope and
the caller's current permission on the resource.

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

Part A applies a standalone-only policy to character list, read and write
operations, including when a character moves into a campaign concurrently.
Part B replaces that policy (stage B2).

Part A stages 1–4 are complete. Stage 5 is complete locally: the contract
drift check, OpenAPI, quickstarts, PostgreSQL rate counters and audit logging
are in place. Its hosted journey is pending.

## Part B — complete the API, including campaigns

### Scope model

| Scope | Grants (always together with the caller’s current permission) |
|---|---|
| `systems:read` / `systems:write` | Unchanged: authoring, versions, lifecycle and system art |
| `characters:read` / `characters:write` | Every character the caller may read or edit in the web app: standalone, owned or controlled in a campaign, and GM-visible sheets. Writes include rolls, pushes, renames, archive/recover, ownership transfer and exports. |
| `campaigns:read` (new) | Campaign, member, invitation, activity, content, template, proposal, media, scene and display-credential reads |
| `campaigns:write` (new) | Every campaign command the caller’s role permits, including invitation accept/decline, display pairing and revocation |

- Commands that change both a character and its campaign need both write
  scopes. These are campaign character creation, assign, claim and adopt.
- Reading a campaign character's sheet needs only `characters:read`; the
  existing GM-visibility and owner-only-notes policy still applies.
- Update the `personal_access_tokens.scopes` CHECK in the schema baseline. No
  migration is needed while no `v*.*.*` tag exists.
- Raise the maximum to six scopes and add the two new checkboxes to Account →
  API tokens.
- Tokens issued before the change keep their original scopes.

### Endpoint additions

Paths are relative to `/api/v1`. Each operation reuses the module command
behind the browser route with the same name. Request and response schemas are
explicit public schemas, never copies of browser DTOs.

**Systems**

| Method and path | Purpose | Scope |
|---|---|---|
| `PATCH /systems/{systemId}` | Archive or recover a system and change its access | `systems:write` |
| `DELETE /systems/{systemId}` | Delete an owned system that nothing references | `systems:write` |
| `GET /systems/{systemId}/versions` | List published versions | `systems:read` |
| `PATCH /system-versions/{versionId}` | Deprecate a published version | `systems:write` |
| `GET .../templates/{templateId}/image/{fileId}[/thumbnail]` (draft and version) | Download system art bytes | `systems:read` |

**Characters**

| Method and path | Purpose | Scope |
|---|---|---|
| `PATCH /characters/{characterId}` | Rename, archive or recover | `characters:write` |
| `GET /characters/{characterId}/templates` | List placeable templates for the character | `characters:read` |
| `POST /characters/{characterId}/actions/{actionId}` | Execute an action or roll with an idempotency key | `characters:write` |
| `GET /characters/{characterId}/rolls/{rollId}` | Read a roll the caller may see | `characters:read` |
| `GET /characters/{characterId}/rolls/{rollId}/push-options` | Read the allowed push choices | `characters:read` |
| `POST /characters/{characterId}/rolls/{rollId}/push` | Push a saved roll | `characters:write` |
| `GET /characters/{characterId}/activity` | Read the character activity feed | `characters:read` |
| `POST /characters/{characterId}/exports` | Export the character state | `characters:read` |
| `POST /characters/{characterId}/ownership-transfer` | Transfer a standalone character to another account | `characters:write` |
| `GET .../portrait[/thumbnail]`, `GET .../entries/{entryId}/image[/{fileId}][/thumbnail]` | Download portrait and entry art bytes | `characters:read` |

**Campaigns: lifecycle, membership and invitations**

| Method and path | Purpose | Scope |
|---|---|---|
| `GET/POST /campaigns` | List the caller’s campaigns; create one pinned to a published version | `campaigns:read` / `campaigns:write` |
| `GET/PATCH /campaigns/{campaignId}` | Read or edit title and description | `campaigns:read` / `campaigns:write` |
| `POST /campaigns/{campaignId}/archive`, `/recover` | Lifecycle | `campaigns:write` |
| `GET /campaigns/{campaignId}/members` | List members with display labels | `campaigns:read` |
| `PATCH/DELETE /campaigns/{campaignId}/members/{userId}` | Change a role or remove a member (character return included) | `campaigns:write` |
| `GET/POST /campaigns/{campaignId}/invitations` | List or create invitations | `campaigns:read` / `campaigns:write` |
| `POST /campaigns/{campaignId}/invitations/{inviteId}/revoke`, `/rotate` | Revoke or rotate | `campaigns:write` |
| `POST /invitations/review`, `/accept`, `/decline` | Act on an invitation token sent in the body | `campaigns:read` (review) / `campaigns:write` |
| `GET /campaigns/{campaignId}/activity` | Read the audience-filtered activity feed | `campaigns:read` |
| `POST /campaigns/{campaignId}/exports` | Export what the caller may read | `campaigns:read` |

**Campaigns: characters, content, templates and proposals**

| Method and path | Purpose | Scope |
|---|---|---|
| `GET/POST /campaigns/{campaignId}/characters` | List attached characters; create a campaign character | `campaigns:read` / `campaigns:write` + `characters:write` |
| `GET /campaigns/{campaignId}/claimable-characters` | Claim discovery | `campaigns:read` |
| `POST /campaigns/{campaignId}/characters/{characterId}/assign`, `/claim`, `/adopt` | Placement commands | `campaigns:write` + `characters:write` |
| `GET/POST /campaigns/{campaignId}/content`; `GET/PATCH/DELETE /content/{contentId}`; `POST /content/{contentId}/grants`, `/recover` | Campaign content with audiences and grants | `campaigns:read` / `campaigns:write` |
| `POST /campaigns/{campaignId}/content-preview` | GM preview as a member | `campaigns:read` |
| `GET/POST /campaigns/{campaignId}/item-templates`; `GET .../bases`; `POST .../item-template-preview` | Template catalog and creation | `campaigns:read` / `campaigns:write` |
| `GET/PATCH /campaigns/{campaignId}/item-templates/{templateId}`; `POST .../archive`, `/recover`, `/sharing` | Template lifecycle and audiences | `campaigns:read` / `campaigns:write` |
| `GET/POST /campaigns/{campaignId}/item-proposals`; `GET .../{proposalId}`; `POST .../approve`, `/reject` | Player proposals and GM review | `campaigns:read` / `campaigns:write` |
| `GET/PUT/DELETE` template and proposal images, plus byte and thumbnail reads | Template and proposal art | `campaigns:read` / `campaigns:write` |

**Campaigns: media, scenes and displays**

| Method and path | Purpose | Scope |
|---|---|---|
| `GET/POST /campaigns/{campaignId}/images`; `DELETE .../images/{fileId}` | Scanned campaign media | `campaigns:read` / `campaigns:write` |
| `GET .../images/{fileId}/original`, `/thumbnail` | GM media bytes | `campaigns:read` |
| `GET/POST /campaigns/{campaignId}/scenes`; `GET/PATCH /scenes/{sceneId}` | Scene library, create, read, replace background | `campaigns:read` / `campaigns:write` |
| `POST /scenes/{sceneId}/fog-edits` | One revision-checked fog batch (≤ 512 runs) | `campaigns:write` |
| `POST /scenes/{sceneId}/tokens`; `PATCH/DELETE /scenes/{sceneId}/tokens/{tokenId}` | Place, move or remove tokens | `campaigns:write` |
| `POST /campaigns/{campaignId}/display-codes` | Mint a display pairing code | `campaigns:write` |
| `GET /campaigns/{campaignId}/display-credentials`; `POST .../displays/{displayId}/revoke` | List or revoke paired displays | `campaigns:read` / `campaigns:write` |

### Outside v1

- Browser session routes: `/me`, `/me/preferences`, `/signout`, and the
  `/dev` routes.
- Token management. It stays in the signed-in Account UI, and a token can never
  manage tokens.
- Display-credential routes under `/displays/...`. These are the redeem route,
  the scene event stream and the redacted image reads. They authenticate with a
  display secret, never with a personal token.
- Live streaming or webhooks for API clients. Scripts read current state and
  use revisions.
- Offline-recovery internals, the browser workspace, bulk mutations, delegated
  OAuth and SDK packages.

### Implementation sequence

Each stage starts with the smallest failing contract and PostgreSQL integration
tests. It then implements the change against existing module boundaries and
reruns the affected HTTP, integration and browser suites. Each stage regenerates
`docs/contracts/public-api-v1.json` and passes the drift check.

| Stage | Work | Exit criteria |
|---|---|---|
| **B1. Scopes and the shared route pattern** | Add `campaigns:read`/`campaigns:write` to Identity, the baseline CHECK and the Account UI. Extend the v1 route definition to accept several required scopes, binary responses with Bearer auth, and the 8 MiB image body limit. Add an `upload` rate bucket. | Tests cover each new scope being missing or insufficient, both-scope commands, and binary auth. Old four-scope tokens keep working. Cross-account and inaccessible IDs collapse to `404`. |
| **B2. Complete systems and characters** | Add the system and character rows above. Replace the standalone-only policy with the Characters policy used by the browser. Attached characters return a public `campaign` summary (campaign ID, controller and claim state) and never owner-only notes for other callers. | A controller can read and roll an attached character, and a GM sees what the browser shows. Other players and outsiders get `404`. Replaying a roll or push with the same key returns the original result. A different body with the same key returns `idempotency_mismatch`. Roll audiences match browser history. |
| **B3. Campaign lifecycle, membership and invitations** | Add the campaign, member, invitation, activity and export rows. Invitation tokens are accepted only in request bodies and are never logged. | A GM script creates a campaign and invites a second account, which accepts through its own token. The new member appears in the web app. Removing a member returns their characters as in the browser. |
| **B4. Campaign characters, content, templates and proposals** | Add those rows. Reuse placement, audience, grant, template-revision and proposal transactions. | Placement, content audience, restricted template and proposal approval journeys pass through v1 with two tokens. Their results match the existing browser acceptance cases. |
| **B5. Media, scenes and displays** | Add those rows. Uploads go through the existing scanner and quotas. Scene commands publish the same `NOTIFY` events, so a paired display updates when the API edits a scene. | An API token move or fog edit reaches a paired browser display over its stream without a map render for token-only moves. Revoking a display through the API ends its stream. |
| **B6. Docs, limits and hosted acceptance** | Extend the quickstart with a campaign walkthrough and add `scripts/public-api-campaign-quickstart.py`. Document per-route retry windows, payload limits and scope requirements. Review the audit log for invitation and display actions. | The full hosted journey below passes on an isolated Railway deployment and its result is recorded under `docs/acceptance/`. |

B1 must land first. B2–B5 are independent once B1 is in. Hosted acceptance
depends on real provider sign-in, as in Part A.

## Wire behavior (both parts)

- **Safe retries.** Every create, command, roll, push and upload uses the JSON
  `idempotencyKey` convention with the receipt scope and retention documented
  per route. A timeout retry sends the same key and an identical body. A
  different body with the same key returns `409 idempotency_mismatch`. A
  revision-checked PUT without a key uses a read-back to confirm a lost
  outcome.
- **Concurrent edits.** Use the existing expected-revision fields:
  `expectedRevision`, `expectedCampaignRevision`, `expectedCharacterRevision`,
  `expectedContentRevision` and `expectedSceneRevision`. A stale revision
  returns `409 conflict` with the latest revision where the caller may see it.
- **Errors and limits.** Use one JSON error envelope with code, message, request
  ID and diagnostics. `401` means missing or invalid credentials, `403` means
  insufficient scope, and `429` comes with `Retry-After`. Inaccessible
  resources stay indistinguishable from missing ones.
- **Privacy.** Responses are filtered for the caller exactly as in the browser.
  This covers roll audiences, content audiences and grants, restricted
  templates, GM-only scene data and owner-only notes. Binary responses are
  `private, no-store`.
- **Release boundary.** Pre-tag deployments are test environments. Change the
  database baseline directly. At the first release tag that includes the API,
  record the supported contract under the release policy.

## Hosted acceptance

1. Confirm the isolated Railway service’s source commit, deployment and
   readiness. Sign in with two real provider test accounts, GM and player, and
   issue tokens. The GM token has all six scopes. The player token has
   `characters:*` and `campaigns:*`. A third read-only token is used for denial
   checks.
2. **Systems and characters (Part A journey).** Validate a bad document and
   check the diagnostics, then save and publish a valid document. Create a
   character, equip gear, attach a portrait, replay a lost create, and confirm
   a stale-revision update conflicts without overwriting a GUI edit.
3. **Campaign setup.** The GM script creates a campaign on the published
   version and invites the player. The player script reviews and accepts the
   invitation, then adopts its character. Verify the membership and the
   adopted sheet in both web sessions.
4. **Play.** The player script executes a roll and pushes it with a replayed
   key. Verify one result appears in the player’s and GM’s activity with the
   correct audience. The GM script publishes restricted content and an item
   template. The player proposes an item and the GM approves it through the
   API. Each result appears in the web app.
5. **Scenes.** The GM script uploads a background, creates a scene, reveals fog
   and places a visible and a hidden token. A browser display paired through an
   API-minted code shows only the visible, revealed token. An API token move
   updates the display without a new map download. Revoking the display through
   the API blanks it.
6. **Denials.** Test a read-only token writing, a token missing
   `campaigns:write`, a player calling GM commands, and an outsider using known
   IDs. Also check that a revoked token returns `401` on the next request.
7. Record the tested commit, deployment and results without credentials, and
   archive the test campaigns.

## Repository references

- [HTTP interface and tenancy rules](https://github.com/Kajonn/sweetroll/blob/main/design_v2.md#13-http-interface-and-real-time-contract)
- [Public API route group](https://github.com/Kajonn/sweetroll/blob/main/src/transport/http/public-api/index.ts)
- [Campaign HTTP adapter](https://github.com/Kajonn/sweetroll/blob/main/src/transport/http/campaigns.ts)
- [Character HTTP adapter](https://github.com/Kajonn/sweetroll/blob/main/src/transport/http/characters.ts)
- [Personal access tokens](https://github.com/Kajonn/sweetroll/blob/main/src/identity/personal-tokens.ts)
- [OpenAPI and client type generation](https://github.com/Kajonn/sweetroll/blob/main/scripts/generate-system-contracts.ts)
- [Application and database release policy](https://github.com/Kajonn/sweetroll/blob/main/docs/superpowers/plans/2026-10-27-application-migration-policy.md)
