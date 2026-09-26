Commit: 15ac1eb + this commit (journey spec, fixture, and this record committed together as `test: full-table journey (system, 5 characters, campaign world, session)`; no product-code changes — the only `src/` change in the journey is the Task 1 seed map already at 15ac1eb)

# Full-table journey acceptance (2026-09-26)

One Playwright spec proves the full table journey: a GM publishes a D&D-like d20 system and round-trips it through the Creator UI, five players each create a character, the GM builds a campaign world (locations + NPCs + invitations), all five join through the invitation UI, and the table completes a session (player sheet rolls, GM session-board bump + roll, activity feed). Auth: pregenerated deterministic test accounts (`code-journey-gm`, `code-journey-p1…p5`), NOT magic link / real OIDC (locked decision, owner-confirmed 2026-09-26; see plan Decisions).

## What ran (exact commands)

E2E evidence (controller-verified, canonical isolated runner with ephemeral DB, from `web/`):

`E2E_DATABASE_ADMIN_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll AUTHORITATIVE_ROLL_SECRET=<from repo .env> node scripts/run-e2e.mjs --suite journeys`

```
4/4 pass in 38.7s
1/4 publish D&D-like system, Creator round-trip (3.5s)
2/4 five players create characters (3.5s)
3/4 campaign world — locations, NPCs, invitations (1.2s)
4/4 join and session (26.5s)
```

Unit gates (this task, before commit):

- `npm test` (repo root): 31 files, 328/328 pass.
- `npm test` (web/): 107 files, 1085/1085 pass.
- `npm run typecheck` (web/): clean, zero errors.

Scope: Chromium-only, dev-server E2E (`web/playwright.config.ts`: backend `npm run migrate && npm run dev:http` + `web:dev`, serial `workers: 1`). The journey spec itself is the e2e evidence; the whole e2e matrix was not re-run here.

## Spec layout (`web/tests/e2e/tableJourney.spec.ts`, 285 lines)

- Test 1/4 (lines 23–59): GM publishes the journey system via `publishJourneySystem` (clone → replace draft → publish, then `PATCH access:"public"` so picker discovery works), then Creator UI round-trip: open, edit description, save (lifecycle `Active` + autosave `Saved`), preview shows `Longsword Attack`.
- Test 2/4 (lines 61–112): players 1–2 create via picker UI (exercises OD-01 discovery of the GM-owned published system); players 3–5 via `POST /api/characters`. Module state `characterIds` (5 entries) for test 4.
- Test 3/4 (lines 114–172): GM creates campaign, 6 `all_players` location notes, 1 `gm_only` note (literal read at `src/campaigns/policy.ts:108`), 10 NPCs as campaign-attached characters (`entityDefinitionId: "character"`, plain — bump actions target the character entity's `hit_points` off-sheet by design), 5 invitations. Handoff via `globalThis __journeyCampaignId` / `__journeyTokens`.
- Test 4/4 (lines 174–285): join + session, all UI. Each player signs in via dev panel in a fresh context, opens `/invitations?token=…` (token never echoed), Accepts, sees `Welcome to`, opens the campaign, reads `Village Green` on Content, `Secret Ledger` absent; each player (360×640) rolls `Longsword Attack` on their sheet (`Roll result` + `/The longsword strike totals/`); GM (360×640) opens the Session tab, `Decrease Hit Points` 10/10 → 9/10, campaign-audience `Roll Longsword Attack` (request body asserted), no uncertain-outcome notice; each player sees `Content created` (first line — six location notes render six) and `Roll executed` in Activity.

(Note: this record uses measured line numbers from the committed file. Tests 3–4 cannot run standalone — they consume module-state `journeyVersionId`/`characterIds` and `globalThis` handoff; always run the full file via the isolated runner.)

## Fixture scale (`web/tests/e2e/tableJourneySystem.ts`, 293 lines)

- System document: 6 integer abilities (3–18) + 6 computed modifiers (`round((score-10)/2, down)`) + `proficiency` + `armor_class` + `hit_points` (10/10) + `spell_slots` (2/2) resources + `ancestry` choice; 15 expressions, 5 actions (3 rolls + `damage_enemy`/`second_wind` bumps), 6 validations, 1 sheet (Basics/Abilities/Combat). Original wording throughout; only grammar-v0.1 constructs mirrored from `src/systems/implementation/package/fixtures/d20.ts`. Server validation passed first-try on publish.
- World: 6 locations + 1 GM-only note, 10 NPCs, 5 standalone characters + 10 attached characters, 5 invitations.

## UI vs API split (per plan, locked)

- UI drives every journey-critical interaction: system edit + preview, 2× picker character creation, 5× invitation accept, per-player join verification, 5× sheet rolls, GM board bump + roll, content reads, GM-only visibility check.
- API seeding covers bulk setup: system publish, 3× character creation, campaign create, 6 location notes + GM note, 10 NPCs, 5 invitation issues, revision bookkeeping. Payload shapes copied from `campaignJourney.spec.ts:91-130` / `test-auth.ts:publishOwnedClone`; UI selectors/testids cited to their source specs in-code.

## Manual findings

None — record only, no manual testing performed in this task. Automated findings from Tasks 3–5 (all resolved inline, cited in-code): library route `/` not `/systems`; `goto("/")` before deriving origin; lifecycle `Active` + autosave `Saved`; entity selection required on create; publish sets `access:"public"`; Activity `Content created` needs `.first()`; player sheet rolls stay `owner_only` by server design (campaign visibility carried by the GM board roll).

## Explicitly did NOT run / is deferred (limitations)

- No real devices — phone coverage is 360×640 Chromium viewports only.
- No real OIDC — pregenerated deterministic test accounts via the test-gated seed map; production `locked` behavior unchanged.
- No playtest-with-humans claim — scripted assertions only (rolls, bumps, activity lines), no human usability signal.
- Full e2e matrix not re-run here; journey spec is the e2e evidence for this change (test-only files, no product code).
