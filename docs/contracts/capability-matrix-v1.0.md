# Capability matrix for grammar 1.0

| Capability | d20 fixture | 2d6 PbtA-style fixture | d6 success-pool fixture |
|------------|-------------|------------------------|-------------------------|
| Scalar fields | ability and stored modifier | move stat and description | attribute and skill ratings |
| Choice/boolean | ancestry and proficiency | playbook and marked condition | specialty and condition |
| Resource | hit points | harm | stress |
| Computed value | defense from numeric fields | current penalty | total pool size |
| Roll | `d20 + fields.modifier` | `2d6 + fields.stat` | dynamic d6 pool counted at threshold 6 |
| Action input | situational modifier | forward modifier | bonus dice |
| Built-in state action | hit-point bump | harm bump | stress reset/bump |
| Validation | bounded ability | bounded stat | non-negative pool |
| Linear sheet | sections, fields, resource, roll | sections, fields, resource, move | sections, fields, resource, roll |

## Current rules

All fixtures use document/package 2.0 and [grammar 1.0](grammar-v1.0.md).
Formulas support typed conditionals, choice membership, resource parts, named
dice groups, and configurable pushes. The conditional d20 scenario exercises
the proficiency and class bonuses and the resource bindings through the public API.

The Roadwardens fixture exercises class progression tables, equipment
aggregation, calculated health maxima, and dataset-backed choices through the
API and browser acceptance flows.

The Winter Compass and Signal Forge fixtures exercise labeled four-die Fudge
rolls and net symbols from one saved pool. The dynamic pool fixtures exercise
explosions, and Hearthbound exercises named move outcomes.

## Deferred

| Capability | Status |
|------------|--------|
| Opposed tests | Deferred |
| Card decks | Deferred |
| Automated roll consequences | Deferred |
