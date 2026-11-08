import { compileDocument } from "../../rules/compile-document.js";
import type {
  FieldV1, ResourceFieldV1, RollActionV1, SheetV1, SourceExpressionV1, SystemDocumentV1,
} from "../schema/document.js";

const name = "Forged in the Dark";
const credit = "Adapted from the Blades in the Dark SRD by John Harper, One Seven Design (https://bladesinthedark.com/basics), under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/).";

const attributes = [
  { id: "insight", label: "Insight", ratings: [["hunt", "Hunt"], ["study", "Study"], ["survey", "Survey"], ["tinker", "Tinker"]] },
  { id: "prowess", label: "Prowess", ratings: [["finesse", "Finesse"], ["prowl", "Prowl"], ["skirmish", "Skirmish"], ["wreck", "Wreck"]] },
  { id: "resolve", label: "Resolve", ratings: [["attune", "Attune"], ["command", "Command"], ["consort", "Consort"], ["sway", "Sway"]] },
] as const;

const playbooks = [
  {
    id: "lockrunner", label: "Lockrunner", ratings: "Finesse 2, Prowl 1",
    ability: "Silent Entry — once per score, open a familiar mundane lock without leaving traces. Roll if entry itself is risky.",
    xp: "Mark playbook XP when you overcome a problem through stealth or precision.",
  },
  {
    id: "broker", label: "Broker", ratings: "Consort 2, Sway 1",
    ability: "Introductions — once per score, name a plausible intermediary who can get you a meeting. The GM decides their price.",
    xp: "Mark playbook XP when you overcome a problem through bargaining or connections.",
  },
  {
    id: "wirewright", label: "Wirewright", ratings: "Tinker 2, Study 1",
    ability: "Spare Parts — once per score, produce the small component needed to attempt a repair or disable a device.",
    xp: "Mark playbook XP when you overcome a problem through invention or research.",
  },
];

function textField(id: string, label: string): FieldV1 {
  return { id, label, kind: "text", default: "", required: false, minLength: 0, maxLength: 500 };
}

function integer(id: string, label: string, max: number): FieldV1 {
  return { id, label, kind: "integer", default: 0, required: true, min: 0, max, step: 1 };
}

function resource(id: string, label: string, max: number, ceiling = max): ResourceFieldV1 {
  return { id, label, kind: "resource", default: { current: 0, max }, min: 0, max: ceiling, step: 1, resetTo: "min" };
}

type Section = SheetV1["sections"][number];

function section(id: string, label: string, fields: readonly FieldV1[]): Section {
  return {
    id, label,
    elements: fields.map((field) => field.kind === "resource"
      ? { kind: "resource", id: `show_${field.id}`, resourceId: field.id }
      : { kind: "field", id: `show_${field.id}`, fieldId: field.id }),
  };
}

function resistanceField(id: string, label: string): FieldV1 {
  return { kind: "computed", id, label: `${label} resistance`, expressionId: `${id}_rating`, valueType: "number" };
}

const identityFields: FieldV1[] = [
  {
    kind: "singleChoice", id: "playbook", label: "Playbook", required: true, default: "lockrunner",
    options: playbooks.map(({ id, label }) => ({ id, label })),
  },
  textField("alias", "Alias"), textField("heritage", "Heritage"), textField("background", "Background"),
  textField("friend", "Close friend"), textField("rival", "Rival"), textField("vice", "Vice and purveyor"),
  textField("abilities", "Special abilities and XP triggers"),
];

const conditionFields = [
  resource("stress", "Stress", 9, 12), textField("trauma", "Trauma"), textField("harm", "Harm by severity"),
  textField("armor", "Armor used"), resource("healing", "Healing clock", 4),
];

const advancementFields = [
  resource("playbook_xp", "Playbook XP", 8), resource("insight_xp", "Insight XP", 6),
  resource("prowess_xp", "Prowess XP", 6), resource("resolve_xp", "Resolve XP", 6),
  resource("coin", "Coin on hand", 4), resource("stash", "Stash", 40),
  resource("downtime_used", "Downtime activities used", 2, 10),
];

const gearFields: FieldV1[] = [
  {
    kind: "singleChoice", id: "load", label: "Load for this score", required: true, default: "light",
    options: [{ id: "light", label: "Light (3)" }, { id: "normal", label: "Normal (5)" }, { id: "heavy", label: "Heavy (6)" }],
  },
  integer("load_used", "Load used", 6),
];

const crewFields = [
  textField("crew_type", "Crew type"), textField("lair", "Lair and hunting grounds"),
  textField("contacts", "Contacts and faction status"), textField("upgrades", "Abilities, claims, cohorts and upgrades"),
  integer("tier", "Tier", 6), textField("hold", "Hold"), integer("wanted", "Wanted level", 4),
  resource("heat", "Heat", 9), resource("rep", "Rep", 12), resource("treasury", "Crew coin", 4, 16),
  resource("crew_xp", "Crew XP", 10),
];

const clockFields = [resource("segments", "Filled segments", 6, 12)];

const ratingSections = attributes.map(({ id, label, ratings }) => {
  const fields = ratings.map(([ratingId, ratingLabel]) => integer(ratingId, ratingLabel, 4));
  return { id: `${id}_actions`, label, fields: [...fields, resistanceField(id, label)] };
});

const gearSection = section("equipment", "Load and gear", gearFields);
gearSection.elements.push({ kind: "slot", id: "show_gear", slotId: "gear" });

const poolExpressions: SourceExpressionV1[] = Array.from({ length: 9 }, (_, count) => ({
  id: `pool_${count}_dice`, context: "roll", resultType: "number", fallback: 0,
  source: count === 0 ? "2d6kl1" : `${count}d6kh1`,
}));

const poolActions: RollActionV1[] = poolExpressions.map(({ id }, count) => ({
  kind: "roll", id: `roll_${count}_dice`, expressionId: id, inputs: [],
  label: count === 0 ? "0 dice — roll 2, keep the lowest" : `Roll ${count}d6 — keep the highest`,
  outputTemplate: count === 0 ? "Lowest die: {total}. A zero-dice roll cannot crit." : "Highest die: {total}. Two or more sixes is a critical.",
}));

const rules = [
  ["pool_rules", "Rolls", "Choose a pool from the relevant rating plus situational dice. On an action roll, 1–3 brings trouble, 4–5 succeeds with a consequence, and 6 succeeds cleanly. With a positive pool, multiple sixes are critical."],
  ["score_rules", "Scores", "Pick an approach and make an engagement roll to establish the opening position. During play the GM sets position and effect. Spend 2 stress to add a die or improve effect. An ally can spend 1 stress to assist and grant a die."],
  ["resistance_rules", "Resistance", "Choose the resistance attribute for the consequence. Mark stress equal to six minus the kept die. A critical clears one stress. The GM decides how much of the consequence is avoided. Filling the stress track causes trauma."],
  ["clock_rules", "Clocks", "Create a clock sheet with 4, 6 or 8 segments. Add or remove segments when the fiction changes. Give the players control of clocks they should update and keep secret clocks under GM control."],
  ["downtime_rules", "Downtime", "After a score record payoff, heat, and entanglements. Characters usually get two downtime activities. Use them for projects, recovery, reducing heat, acquiring assets, training, or indulging a vice."],
] as const;

export const forgedInTheDarkDocument: SystemDocumentV1 = {
  schemaVersion: "1.0",
  metadata: {
    name, language: "en", defaultDice: "d6",
    description: `A crew of thieves takes dangerous jobs in an original setting. Use character, crew, and clock sheets to play scores and downtime. ${credit}`,
  },
  entities: [
    {
      id: "character", label: "Scoundrel",
      fields: [
        ...identityFields,
        ...ratingSections.flatMap(({ fields }) => fields),
        ...conditionFields, ...gearFields, ...advancementFields,
      ],
    },
    { id: "crew", label: "Crew", fields: crewFields },
    { id: "clock", label: "Progress clock", fields: clockFields },
  ],
  sheets: [
    {
      id: "scoundrel_sheet", label: "Scoundrel", targetEntityId: "character",
      sections: [
        section("identity", "Identity and playbook", identityFields),
        ...ratingSections.map(({ id, label, fields }) => section(id, label, fields)),
        {
          id: "roll_pool", label: "Action, resistance, fortune and downtime rolls",
          elements: poolActions.map(({ id }) => ({ kind: "action", id: `show_${id}`, actionId: id })),
        },
        section("condition", "Stress, harm and recovery", conditionFields),
        gearSection,
        section("advancement", "Advancement, payoff and downtime", advancementFields),
      ],
    },
    {
      id: "crew_sheet", label: "Crew", targetEntityId: "crew",
      sections: [section("crew_record", "Crew record", crewFields)],
    },
    {
      id: "clock_sheet", label: "Progress clock", targetEntityId: "clock",
      sections: [section("clock_record", "Progress", clockFields)],
    },
  ],
  expressions: [
    ...attributes.map(({ id, ratings }): SourceExpressionV1 => ({
      id: `${id}_rating`, context: "computed", resultType: "number", fallback: 0,
      source: ratings.map(([ratingId]) => `min(fields.${ratingId}, 1)`).join(" + "),
    })),
    ...poolExpressions,
  ],
  actions: poolActions,
  validations: [],
  slots: [{ id: "gear", label: "Declared gear", accepts: ["item"] }],
  templates: [
    { id: "glass_cutter", label: "Padded glass cutter", kind: "item", description: "Declare for 1 load when cutting or removing a pane.", fields: [], grantedActions: [] },
    { id: "signal_lamp", label: "Shuttered signal lamp", kind: "item", description: "Declare for 1 load when sending a signal across the harbor.", fields: [], grantedActions: [] },
    { id: "cable_spool", label: "Insulated cable spool", kind: "item", description: "Declare for 1 load when rigging a circuit or hauling equipment.", fields: [], grantedActions: [] },
  ],
  referenceData: [
    {
      id: "playbooks", label: "Original playbooks",
      records: playbooks.map(({ id, label, ratings, ability, xp }) => ({ id: `playbook_${id}`, label, values: { ratings, ability, xp } })),
    },
    {
      id: "table_guide", label: "Table guide",
      records: rules.map(([id, label, rule]) => ({ id, label, values: { rule } })),
    },
  ],
};

const compiled = compileDocument(forgedInTheDarkDocument, {
  systemId: "d0000000-0000-5000-8000-000000000001",
  versionId: "d0000000-0000-5000-8000-000000000002",
  semanticVersion: "1.0.0",
});
if (!compiled.ok) throw new Error(`Invalid Forged in the Dark template: ${JSON.stringify(compiled.diagnostics)}`);

export const forgedInTheDarkPackage = compiled.value;
