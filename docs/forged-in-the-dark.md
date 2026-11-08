# Forged in the Dark in Sweetroll

**Forged in the Dark** is a cloneable rules package for running a crew of scoundrels in an original setting. It covers the play loop from assembling the crew through scores, payoff, downtime, and advancement.

## Start a campaign

1. Open **Systems** and choose **Clone Forged in the Dark**. Publish the resulting draft and select its version when creating a campaign.
2. From the campaign roster, create a **Scoundrel** for each player and assign its controller. Create a **Crew** sheet and share it with the whole table by assigning all players as controllers.
3. Add a **Progress clock** sheet for each obstacle, threat, or long-term project. Assign controllers for shared clocks. Keep a GM clock in campaign custody without player controllers. The default clock has six segments. Via the API, set `initialValues.segments` to a pair such as `{"current":0,"max":4}` when creating a clock sheet.
4. For each scoundrel, choose a playbook, enter its starting dots, then add four more dots. Put one into an action that fits the scoundrel's heritage, one into an action that fits their background, and assign the other two freely. Start with no more than two dots per action. Record the ability, XP trigger, friend, rival, and vice on the sheet.

| Original playbook | Starting dots | Starting ability | Playbook XP trigger |
| --- | --- | --- | --- |
| Lockrunner | Finesse 2, Prowl 1 | **Silent Entry.** Once per score, open a familiar mundane lock without leaving traces. Roll if entry itself is risky. | Overcome a problem through stealth or precision. |
| Broker | Consort 2, Sway 1 | **Introductions.** Once per score, name a plausible intermediary who can get you a meeting. The GM decides their price. | Overcome a problem through bargaining or connections. |
| Wirewright | Tinker 2, Study 1 | **Spare Parts.** Once per score, produce the small component needed to attempt a repair or disable a device. | Overcome a problem through invention or research. |

For an API-driven campaign, discover the version in `GET /api/v1/templates` and use its `versionId` as the source of a clone in `POST /api/v1/systems`. The [public API quickstart](api/v1.md#campaign-quickstart) covers publishing and campaign setup.

## Play a score

- Choose an approach and make an engagement roll to establish the opening position. Set position and effect at the table for each action.
- Build the pool from the appropriate rating and bonuses, then select the corresponding button on the scoundrel sheet. A positive pool keeps the highest d6. Two or more sixes count as a critical. With zero or fewer dice, choose **0 dice** to roll two d6s and keep the lower result, with no critical. The sheet offers positive pools of one to eight dice.
- Mark two stress for pushing yourself to add a die or improve effect, or mark one stress when assisting another character. Select load at the start of the score and add gear as you declare it. Record the load used and compare it with the chosen limit.
- When resisting, select the pool from the sheet's calculated Insight, Prowess, or Resolve. Mark six minus the kept die in stress, or clear one stress on a critical. Record harm and armor usage separately. When stress fills, record trauma and apply its consequences at the table.

For **The Harbor Ledger**, the Tidemark Crew must copy an embargo ledger from the Bellharbor customs office before a patrol sweeps the building. Establish the opening position with engagement, declare gear at the window, and tick the patrol clock when the crew draws attention. A collapsing service walkway offers a chance to resist harm on the way out.

## Between scores

Record payoff, reputation, heat, wanted level, and entanglements on the crew sheet. Use each scoundrel's downtime counter to track activities such as recovery, training, a long-term project, or indulging vice. Add a shared project clock if the crew works on an objective together. Use the XP tracks to record advances, then edit the chosen rating or ability when an advance is spent.

The package computes resistance pools and keeps the appropriate dice. The table interprets criticals, chooses position and effect, applies consequences, spends resources, and resolves advancement and downtime. The [Blades SRD](https://bladesinthedark.com/basics) supplies the full procedures.

## Replay and attribution

Run `npm run test:scenario -- -t 'Forged in the Dark'` with a configured test PostgreSQL database. The [scenario](../tests/integration/scenarios/forged-in-the-dark.test.ts) clones and publishes the package, creates the crew and two scoundrels, runs the harbor score, and verifies the shared state after downtime.

Adapted from the [Blades in the Dark SRD](https://bladesinthedark.com/basics) by John Harper, One Seven Design, under [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/). Sweetroll's adaptation adds the Bellharbor setting, playbooks, gear, and score and expresses the rules through Sweetroll sheets and actions.
