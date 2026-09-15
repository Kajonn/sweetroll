# NPC/Monster List Design

Date: 2026-09-15. Slice: GUI plan G7 box 169 remainder (searchable
NPC/monster list leading to a full-width sheet). Approach 1 approved:
creator-designated entity `kind` (system convention), client-side
campaign filtering, existing sheet route reused.

Design authority: `design_v2.md` §§4 (GM nav), 17.9 tasks 4/7;
GM spec `docs/superpowers/specs/2026-09-11-i7-gm-app-design.md`
Phase 2 ("NPC/monster list pages `GET /campaigns/:id/characters`
with client-side filtering and leads to the full-width sheet;
no backend search endpoint").

## Non-goals

- No backend search endpoint; no pagination change to
  `GET /campaigns/:id/characters`.
- No per-campaign override of entity kinds.
- No NPC-only sheet variant; no grammar v0.1 change.
- Preview-as-player stays deferred (G7 box 171 untouched).

## 1. Package schema

`EntityDefinitionV1` gains one optional field:

```ts
kind: Type.Optional(Type.Union([Type.Literal("playable"), Type.Literal("npc")])),
```

Strict mode (`additionalProperties: false`) preserved. Absent `kind`
means `"playable"`. Unknown kind values fail validation through the
existing validation error path. Additive-only: existing packages
validate unchanged; checksum/integrity logic untouched. Reference
fixtures (d20, PbtA) gain one NPC entity each to prove the shape.
Export includes `kind`; import rejects unknown kinds.

Campaign-side resolution reads `kind` from the character's pinned
version package, so characters on old pins behave as all-playable.

## 2. Creation-options contract

`GET /characters/creation-options` entities include `kind`
(absent = `"playable"`). Regenerate OpenAPI + `schema.d.ts`; web
`CreationOptions` types derive from
`operations["get_characters_creation_options"]` (G4 precedent: no
hand-written drift). Additive field only, no endpoint shape break.

## 3. Creator designation UI

`EntityList` rows gain a Playable/NPC toggle on the shared `Select`:
keyboard-operable, persisted through the existing draft-save path
with revision guards. Simple-creator default is Playable; the toggle
sits with existing entity settings (no new canvas, no grammar
exposure).

## 4. Campaign NPC list + search

The Characters tab gains an NPC/monster section listing rows whose
pinned entity `kind` is `"npc"`, with a client-side name-substring
search box. Rows reuse the existing Open path into the character
sheet route; GM visibility rules unchanged (GMs open every roster
sheet, players only controlled sheets). Empty/loading/error/offline
states mirror the existing list; 44px targets, accessible labels,
axe-covered at 360 + 1280 px. Claim/create flows untouched.

## 5. Testing and acceptance

- Unit: schema default-playable + unknown-kind rejection;
  creation-options carries `kind`; toggle flips and round-trips;
  filter/search/empty/offline states.
- `npm run contracts:check` green after regeneration.
- Exit e2e (real HTTP): seed a system with one NPC + one playable
  entity, create one campaign character of each, assert the NPC
  section lists only the NPC row, search narrows it, Open lands on
  the sheet, playable rows excluded.
- Full web suite + typecheck green; acceptance note under
  `docs/acceptance/`; GUI plan box 169 checked only with that
  evidence. Boxes 170/171 untouched.
