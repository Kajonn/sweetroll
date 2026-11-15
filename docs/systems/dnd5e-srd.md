# 5e SRD 5.1 system: what is built and what is missing

**Record · 15 November 2026 · API only, local PostgreSQL 16**

The fifth-edition System Reference Document 5.1 was built as one Sweetroll system
and published, imported and played through public API v1. This record lists what
the system contains, what the SRD has and the system lacks, and why. No engine,
contract or design change was made.

- System document builder: [`tests/integration/fixtures/dnd5e/document.ts`](../../tests/integration/fixtures/dnd5e/document.ts)
- Rules data: [`srd-5.1.json`](../../tests/integration/fixtures/dnd5e/srd-5.1.json) (687 kB) and
  [`srd-5.1-monsters.json`](../../tests/integration/fixtures/dnd5e/srd-5.1-monsters.json) (583 kB), written by
  [`convert-srd.mjs`](../../tests/integration/fixtures/dnd5e/convert-srd.mjs)
- API journey: [`tests/integration/scenarios/dnd5e.test.ts`](../../tests/integration/scenarios/dnd5e.test.ts),
  run with `npm run test:scenario -- -t "5e SRD"`

## Result

The scenario passes (about 19 s, 136 requests, six accounts). It validates and
publishes the document, exports it and imports the export, builds four characters,
checks six more class tables, imports 19 SRD stat blocks as campaign NPCs, runs
targeted attacks in both directions and levels a character up.

Not done: no browser or GUI run, no hosted run, no load test. The 319-option
spell picker and the 100-template catalog were never opened in the web app.

| Budget | Used | Limit |
|---|---|---|
| Document | 856 kB | 1,049 kB (1 MiB) |
| Compiled package | 1,035 kB | 1,049 kB (checked on import only, see gap 1) |
| Templates | 100 | 128 |
| Fields (entities and templates) | 342 | 512 |
| Actions (entity and granted) | 88 | 256 |
| Expressions | 199 | 1,024 |
| Datasets | 19 | 64 |

## What the system contains

| SRD content | In the system | How |
|---|---|---|
| Six abilities, modifiers, 18 skills, saving throws, passive Perception, initiative | All | Computed fields and d20 rolls with advantage, disadvantage and a situational bonus |
| 9 races (each SRD subrace merged into its race) | All | `races` dataset: ability increases, speed, size, traits text, Dwarven Toughness |
| 12 classes, levels 1–20, one SRD subclass each | All, single class | `classes` and `levels` datasets: proficiency bonus, hit die, saving throws, class table, features by level |
| Spell slots, including Pact Magic | All | Nine resources with a maximum looked up per class and level |
| Limited-use class features | 13 | Three generic class resources (Rage, Ki, Sorcery points, Channel Divinity, Lay on Hands and others) and a class die (Sneak Attack, Martial Arts, Bardic Inspiration, Second Wind) |
| 243 class features and the Grappler feat | Full text | One generic "feature" entry with a uses counter; 408 source entries with identical text were merged |
| 319 spells | Full text | One generic "spell" entry; 76 spells roll damage or healing with upcasting and cantrip scaling |
| 37 weapons | All | One generic "weapon" entry: attack, attack a monster, damage, two-handed damage |
| 13 armors and shield | All | Catalog templates; Armor Class is computed from what is worn |
| 187 gear items, tools, mounts and vehicles | All | 78 catalog templates, 109 through a generic "other gear" entry |
| Potions of healing (4) | All | Catalog templates with a healing roll |
| 239 magic items | Name, type and rarity only | Generic "magic item" entry with attunement and charges |
| 334 monsters | As importable stat blocks | `monster` entity with editable values; not rules data (gap 2) |
| 15 conditions | Text and a multi-choice field | No effect on rolls |
| Hit points, hit dice, death saves, temporary hit points, exhaustion, inspiration, coins, carried weight | All | Fields, resources, two warnings (attunement, carrying capacity) |

## Missing because of platform limits

1. **The SRD does not fit one system.** A document may be 1 MiB and compiles to a
   larger package: the first complete build was a 1.32 MB document and a 1.78 MB
   package. Left out to fit: monster stat blocks as rules data (584 kB), magic item
   descriptions (249 kB), the 33 rule sections (195 kB), race age and alignment
   text, and the 123 numbered magic item variants. Extensions cannot carry
   datasets, so the content cannot be split.
   Publishing does not check the package size. A 1,087 kB package published and
   played in a probe run. `decodeSystemExport` rejects a package over 1 MiB, so
   that version could be exported but not imported again (read from the code, not
   run). The system was kept under the limit and the scenario imports its export.
2. **Monsters are sheet values, not a catalog.** The GM creates a "Monster or NPC"
   and types the stat block, or a script posts `srd-5.1-monsters.json` values to
   `POST /campaigns/{id}/characters`. Importing all 334 needs a campaign revision
   read per monster and stays under 120 requests a minute.
3. **One template per weapon is too large.** An expression belongs to one
   template, so 37 weapons need 37 copies of each attack formula (340 kB
   compiled). Weapons, spells, features, other gear and magic items are each one
   template with a choice from a dataset. The template limit (128) is also below
   319 spells.
4. **A sheet does not show looked-up text on an entry.** Computed template fields
   are used by rolls but are not returned with the entry, and a nominal action
   prints its placeholders unreplaced. Each generic entry therefore has a "Show
   spell" style action: a roll of `0` whose result text is the description. It
   is saved as a roll in the activity feed.
5. **Players cannot read reference data.** No player route returns datasets.
   Condition, skill, language and damage type text is in the system and reachable
   only by the author in the editor or an export.
6. **Totals cannot use looked-up values.** Slot aggregates read stored numbers
   only. A generic weapon, gear or magic item entry shows its listed weight; the
   player types the weight that counts. Catalog armor and gear carry it.
7. **A new character does not start full.** A resource with a computed maximum
   starts at its fixed default: a new level 5 wizard has 10 of 27 hit points and
   0 of 4 level 1 slots until the restore actions are used or the script sets the
   values.
8. **No rest action.** A reset action changes one resource. A long rest is 14
   buttons (hit points, nine slot levels, three class resources, hit dice by
   hand). Spending hit dice rolls the healing but changes nothing.
9. **Rolls do not change sheets** (owner decision C10). Damage, healing, spent
   slots, ammunition and death save marks are applied by hand. The scenario
   applies damage with the `adjust` command.
10. **A targeted roll names one entity and always needs a target.** Weapons have
    "Attack" (no target, reports natural 20 and 1) and "Attack a monster" (graded
    against Armor Class). Monster attacks target player characters only. Monster
    against monster and character against character use the ungraded roll.
    Standalone characters cannot use targeted actions.
11. **No advantage primitive that keeps the natural die.** `adv()` and `dis()`
    cannot be named, so every d20 formula rolls a named pool, multiplies it by 0
    and keeps the high or low die. The breakdown shows that extra term.
12. **No multiclassing.** A character has one class and one level. Aggregates
    cannot combine a per-entry value with a lookup, so class levels as entries
    cannot yield spell slots or hit dice.
13. **No conditional layout.** Every sheet shows nine slot meters and three
    "Class resource" meters whose names are separate text fields. Labels are fixed.
14. **The `npc` entity kind is not enforced.** Any account with `characters:write`
    can create a standalone monster sheet.

Already excluded by the [rules coverage plan](../superpowers/plans/2026-11-10-rules-coverage.md):
initiative order and turns, condition and spell effects, durations, concentration,
range, cover and areas.

## Simplified in this system

These are choices made to stay inside the limits above. Each could be changed
without platform work.

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
- Fighter Indomitable, Paladin Divine Sense and the two Channel Divinity classes
  are the only third or shared class resources; other limited features use the
  generic feature entry's counter.

## Environment findings

- `.npmrc` requires Node 24. The container default is Node 22; `/opt/node24` was used.
- Tests under `tests/` are not part of `npm run typecheck`. The new files were
  checked with a one-off strict `tsc` run and are clean.

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
