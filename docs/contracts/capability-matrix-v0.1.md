# Capability Matrix v0.1

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

## Excluded

| Capability | Status |
|------------|--------|
| Class progression tables | Deferred |
| Branching move outcomes | Deferred |
| Equipment aggregation | Deferred |
| Opposed tests | Deferred |
| Push and reroll rules | Deferred |
| Automated roll consequences | Deferred |
