# 5e SRD 5.1 system: what is built and what is missing

**Record · 21 November 2026 (replaces the 16 November record) · API only, local PostgreSQL 16**

The fifth-edition System Reference Document 5.1 is one Sweetroll system,
published, imported and played through public API v1. This record lists what the
system contains, what is still missing and why.

The first record (15 November) listed 14 platform limits. On 16 November the
size limit, entry formulas and multiclassing were addressed; on 21 November the
owner asked for the rest of the
[plan](../superpowers/plans/2026-11-16-srd-gaps-and-shared-formulas.md) to be
implemented (stages S1–S11). Every stage is used by this system.

- System document builder: [`tests/integration/fixtures/dnd5e/document.ts`](../../tests/integration/fixtures/dnd5e/document.ts)
- Rules data: [`srd-5.1.json`](../../tests/integration/fixtures/dnd5e/srd-5.1.json) (1.2 MB) and
  [`srd-5.1-monsters.json`](../../tests/integration/fixtures/dnd5e/srd-5.1-monsters.json) (0.6 MB), written by
  [`convert-srd.mjs`](../../tests/integration/fixtures/dnd5e/convert-srd.mjs)
- API journey: [`tests/integration/scenarios/dnd5e.test.ts`](../../tests/integration/scenarios/dnd5e.test.ts),
  run with `npm run test:scenario -- -t "5e SRD"`

## Result

The scenario passes (about 37 s, 190 requests, six accounts). It publishes the
document, exports and imports it, builds four characters, checks six
single-class and five multiclass tables, creates 19 monsters from presets,
refuses a player's standalone monster, reads rules tables as a player, fights
with attacks against a monster, a character and no target, applies a damage
roll to hit points, takes long rests, levels a fighter up and gives it a rogue
level.

Not done: no browser or GUI run, no hosted run, no load test. The Rules panel,
the apply-roll control, the preset picker and the hidden sheet parts are covered
by web unit tests only.

| Budget | Used | Limit |
|---|---|---|
| Document | 1.98 MB | 5.24 MB (5 MiB) |
| Compiled package | 2.18 MB | 5.24 MB (5 MiB) |
| Fields (entities and templates) | 490 | 512 |
| Templates | 99 | 128 |
| Actions (entity and granted) | 152 | 256 |
| Expressions | 239 | 1,024 |
| Datasets | 21 | 64 |

The field budget is now the binding limit. It is why classes are one template
and why 40 of the 187 gear items are catalog entries.

## What the system contains

| SRD content | In the system | How |
|---|---|---|
| Six abilities, modifiers, 18 skills, saving throws, passive Perception, initiative | All | Computed fields; d20 rolls with advantage, disadvantage and a situational bonus |
| 9 races (each SRD subrace merged into its race) | All | `races` dataset: ability increases, speed, size, traits and lore |
| 12 classes, levels 1–20, one SRD subclass each | All | One "Class" entry per class a character has |
| Multiclassing | Yes | Add a class entry |
| Spell slots and Pact Magic | All | Nine slot resources and a separate Pact Magic pool; empty levels are hidden |
| Limited-use class features | 12 | Up to three meters on each class entry, named by the class, with use and restore actions |
| Class dice | 4 | Sneak Attack, Martial Arts, Bardic Inspiration, Second Wind on the class entry |
| 243 class features and the Grappler feat | Full text | One "feature" entry with a uses counter |
| 319 spells | Full text on the entry | One "spell" entry; 76 spells roll damage or healing with upcasting and cantrip scaling |
| 37 weapons | All, as catalog entries | One template each, sharing one attack and two damage formulas |
| 13 armors and shield | All | Catalog templates; Armor Class is computed from what is worn |
| 187 gear items | All | 40 catalog templates, 147 through an "other gear" entry |
| 4 potions of healing, 362 magic items | All | Potions as catalog entries; magic items with attunement and charges |
| 33 rule sections, conditions, languages, damage types and other tables | Full text | Readable by players through the Rules panel |
| 334 monsters | All, as presets | Create a "Monster or NPC" from the bestiary in a campaign |
| Hit points, hit dice, death saves, temporary hit points, exhaustion, inspiration, coins, carried weight | All | Hit points and slots start full; death saves show at 0 hit points |
| Long and short rests | Yes | One action each |

## Multiclassing

A character is created without a class. Each class is an entry in the "Classes"
list with a class, a level and a "first class" flag. The entry computes what the
class gives at that level and the character adds the entries up: level,
proficiency bonus, hit dice, hit points, saving throws (from the first class),
spell slots (one class's own table, or the multiclass table), Pact Magic and
class dice. Class features with limited uses are meters on the entry; Bardic
Inspiration and Divine Sense read the stored Charisma score.

Checked: fighter 5 / wizard 3, cleric 3 / wizard 2, paladin 4 / sorcerer 3,
warlock 3 / bard 2, cleric 2 / paladin 3, and a rogue level added in play.

Known limits:

- Hit points and slots start full only when they rise from 0. Adding a second
  class raises the maxima and leaves the current values: a fighter 5 / wizard 3
  built in one go has 44 of 62 hit points until a long rest.
- Channel Divinity shows on both entries of a cleric/paladin; the SRD gives one use.
- The sheet's spell save DC and attack bonus use the best casting ability; a spell
  entry can name another.
- Prerequisites (ability score 13) and second-class proficiencies are not checked.

## Closed

| Gap in the first record | Now |
|---|---|
| 1. Size | 5 MiB document and package; publishing rejects a larger package |
| 2. Monsters are not a catalog | The bestiary is the monster entity's presets (S3) |
| 3. One template per weapon is too large | 37 weapon templates share their formulas (S1) |
| 4. Looked-up text is not on the sheet | Entries return computed fields |
| 5. Players cannot read reference data | Rules tables are readable; Rules panel on the sheet (S2) |
| 6. Totals cannot use looked-up values | Aggregates read computed entry fields |
| 7. A new character does not start full | Start-full resources (S4) |
| 8. No rest action | Long rest and short rest batches (S5) |
| 9. Rolls do not change sheets | A person can apply a saved roll's total to a resource (S6, owner decision G5) |
| 10. Targets name one entity and are required | One attack with an optional target of either kind (S7) |
| 11. No advantage without a zero term | One group name per branch (S8) |
| 12. No multiclassing | One class entry per class |
| 13. No conditional layout | Empty slot levels, Pact Magic, Spellcasting and death saves hide (S9) |
| 14. `npc` kind not enforced | Monsters are created by a GM in a campaign (S10) |

## Still missing

- **Initiative order, turns, effects with durations, concentration, range and
  areas.** Excluded by the rules coverage plan; conditions are text.
- **Rest details.** A long rest restores all hit points and slots but not half
  the hit dice (a reset restores all; a fixed amount cannot be half). Class
  features are restored on their class entries, because a batch changes entity
  resources only (decision G4).
- **Applying a roll is one roll to one resource.** Halving for a successful save
  and resistances are applied by hand with the amount control.
- **Monster stat blocks** have three attacks with one damage expression each;
  four SRD monsters have a fourth attack, and breath weapons and spellcasting
  stay in the action text.
- **Spells and features** are one generic entry each, chosen from a list: 319
  spell templates would not fit the field budget.

## Simplified in this system

- Hit points use the fixed value per level; rolled hit points go into an adjustment field.
- The half-elf's two free +1 increases, Dragonborn ancestry, racial and background
  proficiencies and languages are entered by hand.
- Weapon proficiency is a flag on the entry (on by default). Armor proficiency,
  Strength requirements and Stealth disadvantage are text.
- Finesse weapons use the better of Strength and Dexterity. Monk weapons, two-weapon
  fighting, fighting styles and Rage damage go into the "other bonus" input.
- Spell rolls cover one damage or healing expression per spell.

## Environment findings

- `.npmrc` requires Node 24. The container default is Node 22; `/opt/node24` was used.
- Tests under `tests/` are not part of `npm run typecheck`. The new files were
  checked with a one-off strict `tsc` run.
- `tests/integration/character-http-acceptance.test.ts` "serves all three
  reference systems" times out at its 5 s limit in this container, with and
  without these changes.

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
