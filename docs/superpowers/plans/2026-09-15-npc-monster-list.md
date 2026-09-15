# NPC/Monster List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the searchable campaign NPC/monster list: creator-designated entity kinds flow from the system package through creation-options into a client-side NPC section with name search, opening the existing sheet route.

**Architecture:** Additive-only package change (optional entity `kind`, default playable) needs no migration; the runtime maps it into `describeVersion`, the characters module and HTTP DTO expose it, contracts regenerate, the creator toggles it per entity, and the Characters tab filters client-side over the existing `GET /campaigns/:id/characters` list. No new endpoint, no pagination change, no grammar change, no sheet change.

**Tech Stack:** TypeBox/Ajv package schema, SystemRuntime, Fastify DTOs, generated OpenAPI + `schema.d.ts`, React + TanStack Query, shared UI controls, Vitest, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-09-15-npc-monster-list-design.md`

## Global Constraints

- Grammar v0.1 unchanged; no new backend endpoint; no pagination change to any list.
- Additive package change only: old packages validate, old pins behave as all-playable.
- UI strings only via `web/src/i18n/messages.ts` keys, never hardcoded.
- Browser specs run caller-managed: fresh scratch DB, `AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`, dedicated `BACKEND_PORT`/`WEB_PORT`, `CI=1`, `SWEETROLL_BACKEND_TARGET=http://localhost:<backend>`; `workers: 1`, `retries: 0` preserved.
- Scratch DBs are `sweetroll_hard_*` only; never touch the `sweetroll` dev database.
- Never weaken a test to fit behavior; failing exact-enumeration assertions caused by the new field are updated to include it, never deleted.
- Record tested commit, commands, actual result, and limitations in the Task 5 acceptance record. Do not claim production, device, or deployment acceptance.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/systems/implementation/package/schema/document.ts` (modify) | Optional entity `kind` |
| `src/systems/implementation/package/schema/document.test.ts` (modify) | Schema accept/reject tests |
| `src/systems/runtime.ts` (modify) | `VersionDescription` entities carry `kind` |
| `src/systems/runtime.test.ts` (modify) | describeVersion kind tests |
| `src/characters/index.ts` (modify) | `CharacterCreationOptions` entities carry `kind` |
| `src/transport/http/characters.ts` (modify) | `CharacterCreationOptionsDto` entities carry `kind` |
| `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` (regen) | Generated contracts |
| `web/src/state/documentReducer.ts` (modify) | Local `EntityDefinitionV1` gains `kind?` |
| `web/src/editor/EntityList.tsx` (modify) | Playable/NPC toggle |
| `web/src/editor/DocumentEditor.tsx` (modify) | Pass `kind` both directions |
| `web/src/editor/EntityList.test.tsx` (modify) | Toggle tests |
| `web/src/i18n/messages.ts` (modify) | New editor + campaign keys |
| `web/src/campaigns/CampaignCharacters.tsx` (modify) | NPC section + search + kind map query |
| `web/src/campaigns/CampaignCharacters.test.tsx` (modify) | Section/search tests |
| `web/tests/e2e/npcListJourney.spec.ts` (create) | Exit e2e over real HTTP |
| `docs/acceptance/npc-2026-09-15-monster-list.md` (create) | Acceptance record |
| `docs/superpowers/plans/2026-09-08-gui-integration.md` (modify) | Check box 169 only with evidence |

---

### Task 1: Package schema entity kind

**Files:**
- Modify: `src/systems/implementation/package/schema/document.ts` (`EntityDefinitionV1Schema`)
- Modify: `src/systems/implementation/package/schema/document.test.ts` (append tests)

**Interfaces:**
- Consumes: `validDocument()` from `./test-values.js`, Ajv `validate` compiled in the test file.
- Produces (used by Tasks 2–3): `EntityDefinitionV1["kind"]?: "playable" | "npc"`; absent means playable everywhere downstream.

- [ ] **Step 1: Write the failing tests.** Append to the `describe("SystemDocumentV1Schema")` block in `src/systems/implementation/package/schema/document.test.ts`:

```ts
it("accepts playable and npc entity kinds", () => {
  for (const kind of ["playable", "npc"] as const) {
    const value = { ...validDocument(), entities: [{ ...validDocument().entities[0]!, kind }] };
    expect(validate(value)).toBe(true);
  }
});
```

Add one row to the existing `it.each` rejects table, after the `"malformed definition id"` row:

```ts
[
  "unknown entity kind",
  {
    ...validDocument(),
    entities: [{ ...validDocument().entities[0]!, kind: "boss" }],
  },
],
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/systems/implementation/package/schema/document.test.ts` from root. Expected: FAIL on the new accepts test (`kind` rejected by `additionalProperties: false`) and on the new rejects row passing validation unexpectedly (both fail before the fix).
- [ ] **Step 3: Implement.** In `src/systems/implementation/package/schema/document.ts`, extend `EntityDefinitionV1Schema`:

```ts
export const EntityDefinitionV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    label: LabelSchema,
    kind: Type.Optional(Type.Union([Type.Literal("playable"), Type.Literal("npc")])),
    fields: Type.Array(FieldV1Schema, { maxItems: PACKAGE_LIMITS.fields }),
  },
  { additionalProperties: false },
);
```

No other file changes. `structural.ts` reads `entity.id`/`entity.fields` only and needs no edit; confirm by running the suite, not by assumption.

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run src/systems/implementation/package/schema/document.test.ts` from root, then the full root suite `npm test` from root. Expected: PASS, 320/320 (no fixture changed, so no enumeration fallout).
- [ ] **Step 5: Commit.** `git add src/systems/implementation/package/schema/document.ts src/systems/implementation/package/schema/document.test.ts`; `git commit -m "feat(systems): add optional playable/npc entity kind"`.

---

### Task 2: Runtime + characters + HTTP contract carry kind

**Files:**
- Modify: `src/systems/runtime.ts` (`VersionDescription`, `describeVersion` map)
- Modify: `src/systems/runtime.test.ts` (update expectation, add npc test)
- Modify: `src/characters/index.ts` (`CharacterCreationOptions`)
- Modify: `src/transport/http/characters.ts` (`CharacterCreationOptionsDto`)
- Regen: `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` via `npm run contracts:generate`
- Modify: `tests/integration/character-creation-options.test.ts` (two `toEqual` assertions)

**Interfaces:**
- Consumes: Task 1 `kind` on parsed packages (absent = undefined at runtime).
- Produces (used by Tasks 3–4): every entity carries `kind: "playable" | "npc"` with server-side default `"playable"`; web types derive it from the regen output.

- [ ] **Step 1: Write the failing test.** In `src/systems/runtime.test.ts`, update the existing describeVersion expectation to include the defaulted kind:

```ts
entities: [{ id: "character", label: "Character", kind: "playable" }],
```

and append a new test after it:

```ts
it("preserves npc entity kinds from the package", async () => {
  const document = validDocument();
  document.entities.push({ id: "goblin", label: "Goblin", fields: [], kind: "npc" });
  const packageValue = compileRuntimePackage(document);
  const runtime = createRuntime(packageValue);
  const described = await runtime.describeVersion({ versionId: packageValue.versionId });
  expect(described.ok).toBe(true);
  if (!described.ok) return;
  expect(described.value.entities).toEqual([
    { id: "character", label: "Character", kind: "playable" },
    { id: "goblin", label: "Goblin", kind: "npc" },
  ]);
});
```

(`validDocument`, `compileRuntimePackage`, `createRuntime` are already imported/defined in that file.)

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/systems/runtime.test.ts` from root. Expected: FAIL on both tests — the map omits `kind`.
- [ ] **Step 3: Implement the runtime map.** In `src/systems/runtime.ts`, extend the type and the mapper:

```ts
export type VersionDescription = {
  versionId: VersionId;
  packageChecksum: string;
  entities: { id: DefinitionId; label: string; kind: "playable" | "npc" }[];
};
```

```ts
entities: loaded.value.entities.map((entity) => ({
  id: entity.id,
  label: entity.label,
  kind: entity.kind ?? "playable",
})),
```

- [ ] **Step 4: Carry kind through characters + HTTP.** In `src/characters/index.ts`:

```ts
export type CharacterCreationOptions = {
  versionId: VersionId;
  packageChecksum: string;
  entities: { id: DefinitionId; label: string; kind: "playable" | "npc" }[];
};
```

In `src/transport/http/characters.ts`, extend `CharacterCreationOptionsDto`:

```ts
entities: Type.Array(
  Type.Object({
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("playable"), Type.Literal("npc")]),
  }),
),
```

Verify the route handler already forwards `described.value` verbatim (it returns the runtime result directly — confirm, do not add mapping code).

- [ ] **Step 5: Regenerate contracts.** Run: `npm run contracts:generate` from root, then `npm run contracts:check` from root. Expected: generate writes `docs/contracts/openapi-v1.json` + `web/src/api/schema.d.ts`; check passes. Confirm `kind` appears in both outputs (grep for `"kind"` in the creation-options schema region).
- [ ] **Step 6: Update integration assertions (red-first).** In `tests/integration/character-creation-options.test.ts`, update both assertions (lines ~163, ~182) to include the defaulted kind:

```ts
expect(response.json().data.entities).toEqual([{ id: "character", label: "Character", kind: "playable" }]);
```

These tests need a database (`TEST_DATABASE_URL`); run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/character-creation-options.test.ts --no-file-parallelism` from root. If the host port belongs to another project's postgres (see the I7-hardening reachable-postgres ruling in this repo's history), create/use a uniquely-named scratch path only — never write to shared databases; if no database is reachable, record the exact error, run everything else, and mark the report NEEDS_CONTEXT with the blocker. Before the DTO change they fail (missing `kind`); after, they pass.
- [ ] **Step 7: Run to verify it all passes.** Run: `npx vitest run src/systems/runtime.test.ts` and `npm test` (full root suite) from root. Expected: PASS.
- [ ] **Step 8: Commit.** `git add src/systems/runtime.ts src/systems/runtime.test.ts src/characters/index.ts src/transport/http/characters.ts docs/contracts/openapi-v1.json web/src/api/schema.d.ts tests/integration/character-creation-options.test.ts`; `git commit -m "feat(characters): carry playable/npc entity kind into creation-options"`.

---

### Task 3: Creator EntityList kind toggle

**Files:**
- Modify: `web/src/state/documentReducer.ts` (local `EntityDefinitionV1`)
- Modify: `web/src/editor/EntityList.tsx` (`EntityListEntity`, toggle in `EntityDetail`)
- Modify: `web/src/editor/DocumentEditor.tsx` (pass `kind` both directions)
- Modify: `web/src/i18n/messages.ts` (three keys)
- Modify: `web/src/editor/EntityList.test.tsx` (toggle tests)

**Interfaces:**
- Consumes: Task 1–2 (package accepts `kind`; absent = playable).
- Produces (used by Task 4 e2e): creator-authored `kind: "npc"` persists through draft save → publish → creation-options.

- [ ] **Step 1: Write the failing tests.** In `web/src/editor/EntityList.test.tsx`, reuse its `renderList` + `makeEntity` helpers and add:

```tsx
it("toggles an entity between playable and npc", async () => {
  const { onChange } = renderList([makeEntity("npc", "NPC")]);
  await userEvent.click(screen.getByTestId("entity-row-npc-select"));
  await userEvent.selectOptions(screen.getByTestId("entity-kind-picker-npc"), "npc");
  expect(onChange).toHaveBeenLastCalledWith([
    expect.objectContaining([{ id: "npc", kind: "npc" }]),
  ]);
  await userEvent.selectOptions(screen.getByTestId("entity-kind-picker-npc"), "playable");
  expect(onChange).toHaveBeenLastCalledWith([
    expect.objectContaining([{ id: "npc", kind: "playable" }]),
  ]);
});
```

Use the file's existing `user` setup idiom for `userEvent` (mirror the file's imports — it already drives clicks; if it uses `fireEvent`, use `fireEvent.change` on the select instead). Second test: a fresh `addEntity` row renders the picker defaulting to playable (assert `screen.getByTestId(...)` has value `"playable"`).

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/editor/EntityList.test.tsx` from `web/`. Expected: FAIL (`entity-kind-picker-npc` missing).
- [ ] **Step 3: Implement.** In `web/src/state/documentReducer.ts`:

```ts
export type EntityDefinitionV1 = {
  id: string;
  label: string;
  kind?: "playable" | "npc";
  fields: EntityFieldV1[];
};
```

In `web/src/editor/EntityList.tsx`:

```ts
export type EntityListEntity = {
  id: string;
  label: string;
  kind?: "playable" | "npc";
  fields: FieldV1[];
};
```

In `EntityDetail`, after the label `FormField`, add:

```tsx
<FormField label={t("editor.entity.kind.label")}>
  <Select
    label={t("editor.entity.kind.label")}
    id={`entity-kind-${entity.id}`}
    value={entity.kind ?? "playable"}
    onChange={(event) => onChange({ kind: event.target.value as "playable" | "npc" })}
    data-testid={`entity-kind-picker-${entity.id}`}
    options={[
      { value: "playable", label: t("editor.entity.kind.playable") },
      { value: "npc", label: t("editor.entity.kind.npc") },
    ]}
  />
</FormField>
```

(`Select` is already imported in that file.)

In `web/src/editor/DocumentEditor.tsx`, extend the `entityList` mapping to pass `kind` through:

```ts
const entityList: EntityListEntity[] = entities.map((entity) => ({
  id: entity.id,
  label: entity.label,
  kind: entity.kind,
  fields: entity.fields as unknown as EntityListEntity["fields"],
}));
```

The existing `onChange` cast (`next as unknown as EntityDefinitionV1[]`) already carries `kind` back — verify by reading, do not add mapping code there.

In `web/src/i18n/messages.ts` add:

```ts
"editor.entity.kind.label": "Kind",
"editor.entity.kind.playable": "Playable character",
"editor.entity.kind.npc": "NPC / monster",
```

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run src/editor/EntityList.test.tsx` from `web/`, then `npm test` (full web suite) and `npm run typecheck` from `web/`. Expected: PASS, clean.
- [ ] **Step 5: Commit.** `git add web/src/state/documentReducer.ts web/src/editor/EntityList.tsx web/src/editor/DocumentEditor.tsx web/src/i18n/messages.ts web/src/editor/EntityList.test.tsx`; `git commit -m "feat(creator): playable/NPC entity kind toggle"`.

---

### Task 4: Campaign NPC section + search + exit e2e

**Files:**
- Modify: `web/src/campaigns/CampaignCharacters.tsx` (kind-map query in tab, NPC section + search in view)
- Modify: `web/src/i18n/messages.ts` (four keys)
- Modify: `web/src/campaigns/CampaignCharacters.test.tsx` (section/search tests)
- Create: `web/tests/e2e/npcListJourney.spec.ts` (exit e2e)

**Interfaces:**
- Consumes: Task 2 (`kind` on `CreationOptions["entities"][number]`, default playable); Task 3 (creator-authored kinds).
- Produces (used by Task 5): working NPC section + green exit e2e.

- [ ] **Step 1: Write the failing unit tests.** In `web/src/campaigns/CampaignCharacters.test.tsx`, reuse its `viewProps` + `sheet` helpers and render `CampaignCharactersView` with the new `npcEntityIds` prop:

```tsx
it("lists npc-kind rows in the NPC section and keeps them out of the main list", () => {
  render(
    <CampaignCharactersView
      {...viewProps({
        isGm: true,
        characters: [
          sheet({ characterId: "s1", name: "Bram", entityDefinitionId: "hero" }),
          sheet({ characterId: "s2", name: "Goblin", entityDefinitionId: "goblin" }),
        ],
        npcEntityIds: { goblin: true },
        onOpenCharacter: () => {},
      })}
    />,
  );
  expect(screen.getByRole("heading", { name: /monsters & npcs/i })).toBeVisible();
  expect(screen.getByRole("button", { name: /open goblin/i })).toBeVisible();
  expect(screen.queryByRole("button", { name: /open bram/i })).toBeNull();
  expect(screen.getByRole("button", { name: /open bram/i, })).toBeVisible();
});
```

(Correct that last pair: Bram's Open must exist exactly once — in the main list. Write it as: `expect(screen.getAllByRole("button", { name: /open bram/i })).toHaveLength(1);` and Goblin's Open exactly once inside the NPC section.)

```tsx
it("narrows the NPC section by name search and shows an empty state", () => {
  render(
    <CampaignCharactersView
      {...viewProps({
        isGm: true,
        characters: [sheet({ characterId: "s2", name: "Goblin", entityDefinitionId: "goblin" })],
        npcEntityIds: { goblin: true },
        onOpenCharacter: () => {},
      })}
    />,
  );
  fireEvent.change(screen.getByLabelText(/search monsters & npcs/i), { target: { value: "zzz" } });
  expect(screen.getByText(/no monsters or npcs match/i)).toBeVisible();
  expect(screen.queryByRole("button", { name: /open goblin/i })).toBeNull();
  fireEvent.change(screen.getByLabelText(/search monsters & npcs/i), { target: { value: "gob" } });
  expect(screen.getByRole("button", { name: /open goblin/i })).toBeVisible();
});
```

```tsx
it("hides the NPC section when no kinds resolve and keeps every row in the main list", () => {
  render(
    <CampaignCharactersView
      {...viewProps({
        isGm: true,
        characters: [sheet({ name: "Bram" })],
        onOpenCharacter: () => {},
      })}
    />,
  );
  expect(screen.queryByRole("heading", { name: /monsters & npcs/i })).toBeNull();
  expect(screen.getByRole("button", { name: /open bram/i })).toBeVisible();
});
```

Match the file's existing query idioms (it uses `screen.getByRole("button", { name: /open bram/i })` and `fireEvent` — both already imported).

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/campaigns/CampaignCharacters.test.tsx` from `web/`. Expected: FAIL (`npcEntityIds` unknown prop, section missing).
- [ ] **Step 3: Implement the view.** In `web/src/campaigns/CampaignCharacters.tsx`:
  1. Add optional prop `npcEntityIds?: Record<string, true>` to `CampaignCharactersViewProps`.
  2. Extract the per-row `<li>` rendering from the main list into a `CharacterRow` subcomponent in the same file taking `{ character, controlled, openable, onOpen }` and rendering the identical spans + Open button (no visual change to the main list).
  3. In `CampaignCharactersView`, split rows: `const npcRows = props.characters.filter((c) => props.npcEntityIds?.[c.entityDefinitionId] === true);` and `const mainRows = ...` the rest. Render the main list from `mainRows` via `CharacterRow`.
  4. Add search state `const [npcSearch, setNpcSearch] = useState("");` and render the section only when `npcRows.length > 0`:

```tsx
{npcRows.length > 0 ? (
  <section aria-label={t("campaign.detail.characters.npc.title")}>
    <h3>{t("campaign.detail.characters.npc.title")}</h3>
    <FormField label={t("campaign.detail.characters.npc.search.label")}>
      <input
        type="search"
        value={npcSearch}
        onChange={(event) => setNpcSearch(event.target.value)}
      />
    </FormField>
    {filteredNpcRows.length === 0 ? (
      <p role="status">{t("campaign.detail.characters.npc.empty")}</p>
    ) : (
      <ul aria-label={t("campaign.detail.characters.npc.title")}>
        {filteredNpcRows.map((character) => (
          <CharacterRow
            key={character.characterId}
            character={character}
            controlled={isControlled(character, props.actorId)}
            openable={(isControlled(character, props.actorId) || props.isGm === true)}
            onOpen={() => props.onOpenCharacter(character.characterId)}
          />
        ))}
      </ul>
    )}
  </section>
) : null}
```

with `const filteredNpcRows = npcRows.filter((c) => c.name.toLowerCase().includes(npcSearch.trim().toLowerCase()));` (`FormField` and `useState` are already imported/available in that file).
  5. In `CampaignCharactersTab`, resolve the kind map with a query over the distinct system versions in the loaded rows (after the `characters.status` guards, next to the existing `claimable` hook):

```tsx
const versionIds = [...new Set(rows.map((row) => row.systemVersionId))];
const entityKinds = useQuery({
  queryKey: ["campaigns", "entity-kinds", props.campaignId, ...versionIds, generation],
  queryFn: async () => {
    const found = await Promise.all(
      versionIds.map(async (versionId) => {
        try {
          const options = await props.metadataApi!.creationOptions(versionId);
          return options.data.entities
            .filter((entity) => (entity.kind ?? "playable") === "npc")
            .map((entity) => entity.id);
        } catch {
          return [];
        }
      }),
    );
    return Object.fromEntries(found.flat().map((id) => [id, true]));
  },
  enabled: props.metadataApi !== undefined && online && versionIds.length > 0,
});
```

and pass `npcEntityIds={entityKinds.data}` to `CampaignCharactersView`. (`useQuery` is already imported in that file; `CreationOptions["entities"][number]` carries `kind` after the Task 2 regen.)
  6. In `web/src/i18n/messages.ts` add:

```ts
"campaign.detail.characters.npc.title": "Monsters & NPCs",
"campaign.detail.characters.npc.search.label": "Search monsters & NPCs",
"campaign.detail.characters.npc.empty": "No monsters or NPCs match.",
"campaign.detail.characters.npc.offline": "NPC filtering needs a connection. Reconnect to refresh kinds.",
```

  (The offline key is used for a `role="status"` line when `!online`, mirroring the claim-discovery offline pattern.)

- [ ] **Step 4: Run unit + typecheck.** Run: `npx vitest run src/campaigns/CampaignCharacters.test.tsx` from `web/`, then `npm test` and `npm run typecheck` from `web/`. Expected: PASS, clean.
- [ ] **Step 5: Write the exit e2e.** Create `web/tests/e2e/npcListJourney.spec.ts`, one test, default desktop viewport, mirroring the seeding/UI selectors of `web/tests/e2e/gmSessionJourney.spec.ts` steps 1–2 (API clone of d20) and its step 8 (UI character creation: name + system version ID + Load entity options + entity + New campaign character):
  1. Seed as `code-test-a` via real HTTP: clone d20, save the draft with the second entity patched to `kind: "npc"`, publish 1.0.0 (same clone→save→publish shape as `gmSetupJourney.spec.ts` steps 1–2, plus the kind patch).
  2. Dev-sign-in, create campaign `NPC List <uid>` through `/campaigns/new`, open Characters tab.
  3. Create `Goblin` on the npc entity + `Hero` on the playable entity through the create panel.
  4. Assert the `Monsters & NPCs` section lists Goblin and not Hero; Hero's Open appears once in the main list.
  5. Search `gob` → Goblin visible; search `zzz` → empty state; clear → Goblin visible again.
  6. Open Goblin → character sheet route renders (heading), back to detail.
  7. `afterEach` deletes the cloned system via `DELETE /api/systems/:id` (pattern from `visual.spec.ts:27-32`); campaign names carry the per-run stamp (no campaign DELETE endpoint).
- [ ] **Step 6: Run e2e isolated.** Run: create scratch DB `sweetroll_hard_npc` (compose postgres via `docker compose exec`, per the plan Global Constraints), then from `web/`: `DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_hard_npc AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes BACKEND_PORT=3116 WEB_PORT=5186 CI=1 SWEETROLL_BACKEND_TARGET=http://localhost:3116 npx playwright test tests/e2e/npcListJourney.spec.ts --reporter=list`. Expected: PASS 1/1. (If host `localhost:5432` belongs to another project's postgres, create the scratch DB in the reachable postgres via its container exactly as the I7-hardening Task 1 ruling allowed, still `sweetroll_hard_*` only.)
- [ ] **Step 7: Commit.** `git add web/src/campaigns/CampaignCharacters.tsx web/src/campaigns/CampaignCharacters.test.tsx web/src/i18n/messages.ts web/tests/e2e/npcListJourney.spec.ts`; `git commit -m "feat(campaigns): searchable NPC/monster section with client-side filter"`.

---

### Task 5: Acceptance record + GUI plan box update

**Files:**
- Create: `docs/acceptance/npc-2026-09-15-monster-list.md`
- Modify: `docs/superpowers/plans/2026-09-08-gui-integration.md` (box 169 note only)

**Interfaces:**
- Consumes: evidence from Tasks 1–4 (suite results, e2e result, contracts check).
- Produces: the slice closure record. Must NOT touch boxes 170/171 or any G9 gate.

- [ ] **Step 1: Write the acceptance record.** `docs/acceptance/npc-2026-09-15-monster-list.md`: tested commits (Tasks 1–4 SHAs from the branch), per-task commands + outcomes + limitations (Chromium-only, no real devices, scratch-DB e2e, fail-closed kind resolution), and the explicit remaining gap (per-campaign kind overrides out of scope; preview-as-player untouched).
- [ ] **Step 2: Run full verification.** Root `npm test`, `npm run typecheck`, `npm run contracts:check`, `npm run build`; web `npm test`, `npm run typecheck`, `npm run build`; `git diff --check`. Record results in the acceptance record. A single-test web-unit flake requires two consecutive green reruns before claiming green.
- [ ] **Step 3: Update the GUI plan.** In `docs/superpowers/plans/2026-09-08-gui-integration.md`, append to the box-169 note (do not rewrite history): NPC/monster list landed with evidence pointer, or record what stayed open if it did not. Touch no other box.
- [ ] **Step 4: Commit.** `git add docs/acceptance/npc-2026-09-15-monster-list.md docs/superpowers/plans/2026-09-08-gui-integration.md docs/superpowers/plans/2026-09-15-npc-monster-list.md`; `git commit -m "docs(npc): record monster-list acceptance and close GUI box 169"`. (Include the plan file itself so the branch carries its own instructions.)
