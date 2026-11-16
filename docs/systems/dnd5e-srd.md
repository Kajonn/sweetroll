# 5e SRD 5.1 system: what is built and what is missing

**Record · 16 November 2026 (replaces the 15 November record) · API only, local PostgreSQL 16**

The fifth-edition System Reference Document 5.1 is one Sweetroll system,
published, imported and played through public API v1. This record lists what the
system contains, what is still missing and why.

On 2026-11-16 the owner asked for the gaps of the first record to be addressed.
Four are closed, with three platform changes; the
[plan](../superpowers/plans/2026-11-16-srd-gaps-and-shared-formulas.md) proposes
the rest and a way to share formulas.

- System document builder: [`tests/integration/fixtures/dnd5e/document.ts`](../../tests/integration/fixtures/dnd5e/document.ts)
- Rules data: [`srd-5.1.json`](../../tests/integration/fixtures/dnd5e/srd-5.1.json) (1.2 MB) and
  [`srd-5.1-monsters.json`](../../tests/integration/fixtures/dnd5e/srd-5.1-monsters.json) (0.6 MB), written by
  [`convert-srd.mjs`](../../tests/integration/fixtures/dnd5e/convert-srd.mjs)
- API journey: [`tests/integration/scenarios/dnd5e.test.ts`](../../tests/integration/scenarios/dnd5e.test.ts),
  run with `npm run test:scenario -- -t "5e SRD"`

## Result

The scenario passes (about 28 s, 177 requests, six accounts). It validates and
publishes the document, exports it and imports the export, builds four
characters, checks six single-class and five multiclass tables, imports 19 SRD
stat blocks as campaign NPCs, runs targeted attacks in both directions, levels a
fighter up and gives it a level of rogue.

Not done: no browser or GUI run, no hosted run, no load test. The 319-option
spell picker, the class list and the computed entry text were never opened in
the web app for this system (the web unit test covers the rendering).

| Budget | Used | Limit |
|---|---|---|
| Document | 1.38 MB | 5.24 MB (5 MiB) |
| Compiled package | 1.58 MB | 5.24 MB (5 MiB) |
| Templates | 101 | 128 |
| Fields (entities and templates) | 394 | 512 |
| Actions (entity and granted) | 81 | 256 |
| Expressions | 246 | 1,024 |
| Datasets | 20 | 64 |

## What the system contains

| SRD content | In the system | How |
|---|---|---|
| Six abilities, modifiers, 18 skills, saving throws, passive Perception, initiative | All | Computed fields and d20 rolls with advantage, disadvantage and a situational bonus |
| 9 races (each SRD subrace merged into its race) | All | `races` dataset: ability increases, speed, size, traits and lore text, Dwarven Toughness |
| 12 classes, levels 1–20, one SRD subclass each | All | One "Class" entry per class a character has; see Multiclassing |
| Multiclassing | Yes | Add a class entry |
| Spell slots and Pact Magic | All | Nine slot resources and a separate Pact Magic pool |
| Limited-use class features | 12 | Named resources (Rage, Ki, Sorcery points, Channel Divinity, Lay on Hands and others); a class die on the class entry (Sneak Attack, Martial Arts, Bardic Inspiration, Second Wind) |
| 243 class features and the Grappler feat | Full text | One generic "feature" entry with a uses counter; 408 source entries with identical text were merged |
| 319 spells | Full text on the entry | One generic "spell" entry; 76 spells roll damage or healing with upcasting and cantrip scaling |
| 37 weapons | All | One generic "weapon" entry: attack, attack a monster, damage, two-handed damage |
| 13 armors and shield | All | Catalog templates; Armor Class is computed from what is worn |
| 187 gear items, tools, mounts and vehicles | All | 78 catalog templates, 109 through a generic "other gear" entry |
| Potions of healing (4) | All | Catalog templates with a healing roll |
| 362 magic items | Full text on the entry | Generic "magic item" entry with attunement and charges |
| 33 rule sections | Full text | `rules` dataset (39 records; long sections are split). Readable by the author only (gap 5) |
| 334 monsters | As importable stat blocks | `monster` entity with editable values; not rules data (gap 2) |
| 15 conditions | Text and a multi-choice field | No effect on rolls |
| Hit points, hit dice, death saves, temporary hit points, exhaustion, inspiration, coins, carried weight | All | Fields, resources and four warnings |

## Multiclassing

A character is created without a class. Each class is an entry in the "Classes"
list with a class, a level and a "first class" flag. Adding a class is adding an
entry; gaining a level is editing its level.

The entry computes what the class gives at that level and the character adds the
entries up:

- Character level, proficiency bonus and hit dice come from the sum of the levels.
- Hit points use the full hit die for the first class's first level and the fixed
  average for every other level.
- Saving throw proficiencies come from the class marked first.
- One spellcasting class uses its own slot table. Two or more add their levels
  (half for paladin and ranger) and use the full caster table. Pact Magic stays
  a separate pool.
- Class resources are summed. Channel Divinity takes the highest value instead.
- Each class entry has its own class die and "spend hit dice" roll.

Checked in the scenario: fighter 5 / wizard 3, cleric 3 / wizard 2, paladin 4 /
sorcerer 3, warlock 3 / bard 2, cleric 2 / paladin 3, and a fighter who takes a
rogue level during play.

Known limits of this model:

- The sheet's spell save DC and attack bonus use the best spellcasting ability
  among the classes. A spell entry has a "spellcasting ability" choice for the
  other class.
- "Spells known or prepared" adds each class's count without the minimum of one
  per class.
- Multiclass prerequisites (ability score 13) and the reduced proficiencies of a
  second class are not checked.
- A new sheet has 1 hit point until a class is added and "restore hit points" is
  used (gap 7).
- The class list holds six entries. Each entry costs sheet budget for about
  40 computed fields.

## Closed on 2026-11-16

| Gap in the first record | Now |
|---|---|
| 1. The SRD does not fit one system | The limit is 5 MiB for a document and for its compiled package. Publishing rejects a larger package. Magic item descriptions, all magic items, the rule sections and race lore are back. |
| 4. A sheet does not show looked-up text on an entry | The sheet and `/api/v1` return computed entry fields. The "Show spell" workaround actions are removed. |
| 6. Totals cannot use looked-up values | Slot aggregates read computed number fields. |
| 12. No multiclassing | See above. |

## Still missing because of platform limits

Numbers are those of the first record. Each has a proposed stage in the
[plan](../superpowers/plans/2026-11-16-srd-gaps-and-shared-formulas.md).

2. **Monsters are sheet values, not a catalog.** The GM types a stat block or a
   script posts `srd-5.1-monsters.json` values to `POST /campaigns/{id}/characters`.
3. **One template per weapon needs shared formulas.** An expression belongs to
   one template, so weapons, spells, features, other gear and magic items are
   each one template with a choice from a dataset. The plan proposes letting
   several templates use one expression.
5. **Players cannot read reference data.** Condition, skill, language and rule
   section text is in the system and reachable only by the author. Spell,
   feature and magic item text is now visible through entries.
6. (Partly open.) A generic weapon, gear or magic item entry still needs its
   weight typed, because the weight that counts is a stored per-unit field.
7. **A new character does not start full.** Resources with a computed maximum
   start at their default: 1 hit point, no spell slots, no class resource uses.
8. **No rest action.** A reset action changes one resource. There are restore
   actions for hit points, nine slot levels and Pact Magic; the twelve class
   resources are set on their meters.
9. **Rolls do not change sheets** (owner decision C10). Damage, healing, spent
   slots, ammunition and death save marks are applied by hand.
10. **A targeted roll names one entity and always needs a target.** Weapons have
    "Attack" and "Attack a monster". Monster attacks target player characters only.
11. **No advantage primitive that keeps the natural die.** Every d20 formula
    rolls a named pool, multiplies it by 0 and keeps the high or low die.
13. **No conditional layout.** Every sheet shows nine slot meters, the Pact Magic
    pool and twelve class resource meters, most of them 0 of 0.
14. **The `npc` entity kind is not enforced.** Any account with `characters:write`
    can create a standalone monster sheet.

Already excluded by the [rules coverage plan](../superpowers/plans/2026-11-10-rules-coverage.md):
initiative order and turns, condition and spell effects, durations, concentration,
range, cover and areas.

## Simplified in this system

- Hit points use the fixed value per level. Rolled hit points go into an adjustment field.
- The half-elf's two free +1 increases, Dragonborn ancestry, racial and background
  proficiencies and languages are entered by hand. The Acolyte background is text.
- Weapon proficiency is a flag on the entry (on by default). Armor proficiency,
  Strength requirements and Stealth disadvantage are text.
- Finesse weapons use the better of Strength and Dexterity. Monk weapons, two-weapon
  fighting, fighting styles and Rage damage go into the "other bonus" input.
- Fast Movement applies to a barbarian in any armor. Unarmored Movement stops
  when a monk wears armor or a shield.
- A stat block has three attack slots with one damage expression each. Four SRD
  monsters have a fourth attack; extra damage types, save DCs, breath weapons and
  monster spellcasting stay in the action text.
- Spell rolls cover one damage or healing expression per spell. Spells with
  several parts use "Roll any dice".

## Environment findings

- `.npmrc` requires Node 24. The container default is Node 22; `/opt/node24` was used.
- Tests under `tests/` are not part of `npm run typecheck`. The new files were
  checked with a one-off strict `tsc` run and are clean.
- `tests/integration/character-http-acceptance.test.ts` "serves all three
  reference systems" times out at its 5 s limit in this container, with and
  without these changes. The other 452 integration tests pass.

## Licence

This work includes material taken from the System Reference Document 5.1 ("SRD
5.1") by Wizards of the Coast LLC, available at
<https://dnd.wizards.com/resources/systems-reference-document>. The SRD 5.1 is
licensed under the Creative Commons Attribution 4.0 International License,
<https://creativecommons.org/licenses/by/4.0/legalcode>. The same statement is in
the system description.

The structured data was converted from <https://github.com/5e-bits/5e-database>
(`src/2014/en`, MIT License). That repository's README names the Open Gaming
License for the underlying material; Wizards of the Coast released the same SRD
5.1 text under CC BY 4.0 in 2023. **Open for the owner:** confirm CC BY 4.0 as
the licence relied on before the system is shared publicly.
