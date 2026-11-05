# System presentation contract (T1)

Store optional `metadata.presentation: { colorPreset: "default" | "blue" | "ochre" }`
in the current system document; compile it to the package's `presentation`.
Absence resolves to Default without rewriting historical package bytes. Unknown
IDs and extra properties fail structural validation with document paths.
Normal revision-safe saves, signing, immutable versions, clone/import/export and
the authorized cached character projection carry this data. Rules and state do
not change. Projection absence resolves to Default.

The creator Basics tab selects the preset and updates its existing working
document immediately; draft sync owns saved/conflict status. Preview and playing
sheets inherit a React presentation scope. The shared Dialog receives that scope
through context, including its portal. Global navigation and account preferences
remain outside the scope. Light/dark resolution stays device > account > OS.
Use semantic CSS aliases in each scoped surface so aliases resolve locally.
Never set system colors on documentElement or persist a last-selected system.
Mode and presentation changes do not key/remount working components.

T2 and M0–M3 retain their staged acceptance dependencies in the feature plan.
