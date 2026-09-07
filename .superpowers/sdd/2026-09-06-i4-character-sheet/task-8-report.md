# Task 8 Report: Creation and Embeddable Routes

Commit: `feat: create and open standalone character sheets`

## Delivered

- Added `web/src/characters/CreateCharacter.tsx` (props: `api`/`store`/`identity`/`onCreated`/`initialSystemVersionId`; no global router ownership):
  - Optional `systemVersionId` search input with `Look up version` loading authorized metadata only via Task 2 `api.creationOptions(versionId)`; entity `<select>` + name input rendered only after authorized metadata. No package export parsing.
  - Denied metadata (403/404) shows single generic `character.create.denied` string, hides entity/create controls, never authorizes creation.
  - Online-only creation: offline renders `character.create.offline` status, never calls `creationOptions`/`send`, hides create button.
  - Account-scoped durable creation attempts before send: builds `{systemVersionId, entityDefinitionId, name, idempotencyKey}` + `FrozenRequest {POST /characters, body, firstAttemptAt}`, persists via `store.saveOnlineAttempt` in the actor partition before `api.send(attempt.request)` verbatim (transport never mints keys, Task 3 contract).
  - Double-click suppression via `submitting` ref + `busy` disable; `created` ref guarantees `onCreated(characterId)` exactly once.
  - Uncertain-create recovery: on mount reads `store.readOnlineAttempts(actor)` for `kind === "create"`, restores version/entity/name fields, shows pending status + `Retry creation` button; retry reuses the durable `attempt.request` verbatim (identical body/key). Success deletes the attempt then calls `onCreated` once. 403/404/422 on create clears the pending attempt with denied/invalid messaging; 401 keeps attempt with reauth message; network/malformed stays uncertain with same key.
- Added `web/src/characters/CharacterRoute.tsx`:
  - `CharacterDetail` composes shipped Task 4 store + Task 5 session/identity ports + Task 6 coordination + Task 7 renderer as `<CharacterSheet snapshot={snapshot} onSetField={session.setField} onBump={session.bumpResource} />` (no action ownership on standalone route; `CharacterSheet` `onExecuteAction` made optional with offline/read-only gating preserved).
  - Session created per `actorId:characterId` via `createCharacterSession`, opened by `useCharacterSession`, disposed on unmount (`letGo`/`dispose` asserted).
  - Required-field focus after navigation: completion `<h2 id="character-completion" tabIndex={-1}>` focused once per `actorId:characterId` when `completionFields` present.
  - Cached-character recovery links only: `store.listCharacters(actorId)` (new account-scoped method; `IDBKeyRange.bound([actorId],[actorId,MAX])`, confirmed-only) filtered to exclude current character; links to `/characters/new` + `/`; no searchbox, no I5 search/recent/library.
  - Deep-link privacy: reads only `identity.getActorId()` partition; another account's cache never rendered; purge dispositions flow through session/store; test asserts original account snapshot retained.
  - `NewCharacterRoute` thin adapter over `CreateCharacter` with storage-unavailable fallback; `useSharedCharacterStore` shares one IndexedDB handle.
- Modified `web/src/router.tsx`: registered static `/characters/new` (with `validateSearch {systemVersionId?}`) before dynamic `/characters/$characterId`, preserving `/` and `/systems/$systemId`. Route views resolve `useIdentity()` + shared store + `useCharactersApi()` and navigate `onCreated -> /characters/$characterId`. Added `useIdentityTick` (`useSyncExternalStore` over `IdentityGate.subscribe`/`getSnapshot().generation`) so async `/me` verification re-renders route views (AppShell header updated but same-reference gate context did not re-render routes without this).
- Modified `web/src/shell/AppShell.tsx`: header entry link `<a href="/characters/new">` (`shell.nav.newCharacter`).
- Modified `web/src/publish/VersionHistory.tsx`: per-version `<a href="/characters/new?systemVersionId=...">` (`versionHistory.action.createCharacter`).
- Modified `web/src/characters/store.ts`: added account-scoped `listCharacters(actorId)`.
- Modified `web/src/characters/CharacterSheet.tsx`: optional `onExecuteAction`, focusable completion heading.
- Modified `web/src/i18n/messages.ts`: creation/detail/shell strings including verbatim `Complete Your Character` heading required by brief.
- Tests: `CreateCharacter.test.tsx` (6) covers selected version/entity/name creation + `onCreated` once, denied 403/404 generic message, online-only block, double-click single send/single `onCreated`, reload uncertain retry with `expect(firstCreate.body).toEqual(retriedCreate.body)` + `expect(onCreated).toHaveBeenCalledTimes(1)`, initial version-ID search input. `CharacterRoute.test.tsx` (6) covers session composition/disposal, `expect(screen.getByRole("heading", { name: "Complete Your Character" })).toBeVisible()` + focus, offline recovery links without searchbox, cross-account deep-link isolation, System Builder route preservation, creation-route search input over real router.

## Verification (TDD red → green)

- Red: `npm run web:test -- src/characters/CreateCharacter.test.tsx src/characters/CharacterRoute.test.tsx` → 1 failed / 11 passed (`charactersApi is not defined` error boundary on `/characters/new`; `Unable to find a label with the text of: System version ID`, offline message shown). `npm run web:typecheck` → 5 errors (`charactersApi` undefined ×2, `exactOptionalPropertyTypes` on `initialSystemVersionId` ×2, optional `onExecuteAction` invocation ×1).
- Fixes: wired `useCharactersApi()` into both route views; typed `initialSystemVersionId?: string | undefined`; narrowed `ActionControl` to `NonNullable<...>`; added `useIdentityTick` subscription; stabilized first creation test with `await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))` and `await waitFor(() => expect(store.readOnlineAttempts(...)).resolves.toHaveLength(0))` (was racy: `send` resolved before `deleteOnlineAttempt`+`onCreated` completed; flaked 1/3 combined runs).
- Green focused (3× stable): `npm run web:test -- src/characters/CreateCharacter.test.tsx src/characters/CharacterRoute.test.tsx` → 2 files, 12/12 passed.
- Full: `npm run web:test` → 53 files, 410/410 passed.
- `npm run web:typecheck` → passed.
- `npm run web:build` → passed (1812 modules, `dist/index.html` + CSS/JS emitted).
- Router/shell preserved: `src/router.test.tsx` (1) + `src/shell/AppShell.test.tsx` (6) pass within full suite; System Builder library route asserted in CharacterRoute test.

## Contracts reused (no divergent shapes)

- Task 2 `CreationOptions`/`creationOptions(versionId)`; Task 3 `CharactersApi.send(FrozenRequest)` verbatim body+key + `ApiError` status branches + `POST /signout` untouched; Task 4 `CharacterStore` + `FrozenRequest`/`OnlineAttempt(kind:"create",characterId:null)` + `listCharacters` additive only; Task 5 session `open/subscribe/setField/bumpResource/dispose` + snapshot shape; Task 6 `IdentityGate`/`createCoordination` real ports; Task 7 `CharacterSheet` snapshot/callbacks.

## Limitations

- Existing React `act(...)` warnings from router tests persist; no failures.
- Browser-level offline/service-worker acceptance (Task 10/11) not run here; only jsdom/fake-indexeddb unit coverage for routes.
