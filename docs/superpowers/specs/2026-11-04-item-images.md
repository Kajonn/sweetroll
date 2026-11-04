# M2 item images

This extends the existing item, spell, talent and effect templates and entries.
Images are presentation; they add no actions, editable mechanics or rules fields.
M1 passed its hosted journey and CI #209 before this implementation began.

## Storage and authority

A private immutable item-image asset records normalized bytes, bounded thumbnail,
checksums, dimensions, content type, uploader and optional campaign provenance.
The existing M0 scanner/processor and mounted media root are reused. The concrete
need for shared retained bytes is that Systems publishes art, Campaigns discloses
it and Characters retains placed copies after return. A private platform storage
helper supports these three owning Modules; there is no global asset HTTP route,
new service, public object URL or authorization delegated to storage.

Every read first authorizes the parent and verifies its exact asset reference,
then verifies bytes and rechecks authority after I/O. UUID file identity never
accepts a client path. No image bytes or bearer URLs enter character queues or
service-worker caches. Offline play shows a placeholder. Uploads retain M0's
PNG/JPEG/WebP, 5 MiB input, 4096 px, thumbnail and fail-closed scan limits.
Item storage enforces 100 MiB/256 accepted assets per uploader/campaign, including
thumbnails, with serialized checks. Failed writes remove newly prepared files.
Accepted immutable bytes are conservatively retained while disclosed copies or
published snapshots may refer to them; removal only changes an authorized link.

## System templates and portability

A template's optional image descriptor carries an opaque local asset ID,
description, content type, dimensions, safe byte size and checksum. Draft saves
can retain only system-authorized references; copying a guessed ID into authored
JSON cannot attach another system, campaign or character's art. The Systems
Module owns retained-reference permissions. Creator upload/remove requires the
observed draft revision and idempotency key, and atomically updates its descriptor,
draft checksum/revision, asset metadata and receipt. Publication freezes the exact
descriptor with the package. Later edits cannot restyle a published or placed copy.

Clone retains the source version's disclosed safe references under the new system
in the same draft transaction. Import never resolves an arbitrary local asset ID:
it requires a complete bounded manifest, verifies each original checksum, scans
and normalizes every supplied file, allocates local identities and rewrites the
new draft's descriptors. The manifest contains no credentials, filesystem paths,
private campaign references or external fetch URLs. An imported image receives a
new local identity/checksum after normalization; clone keeps exact safe bytes.

The package/document's existing 1 MiB rules budget remains. A system export may
add up to 128 distinct image manifest entries, with at most 10 MiB safe image bytes
in total and a 16 MiB encoded envelope limit. Import HTTP has a bounded 18 MiB outer
JSON limit. Export includes every referenced system image exactly once or fails
clearly on missing/corrupt/inaccessible art or size budget; it never silently emits
a partial bundle. No original-version migration path is added.

Creator image editing uses a modal after the existing confirmed autosave, using the same clean-draft readiness
gate as publication. It freezes the observed revision and exact image request while
busy and adopts the new workspace only after success; unsaved creator text cannot
be overwritten by a late image response. Read-only published views expose no edit
controls. The original light/dark and scoped presentation behavior is retained.

## Campaign templates and proposals

Template image metadata is separate from the editable data/action content. GM or
co-GM changes require the expected template revision and idempotency key, use the
existing campaign-first lock/policy order, and advance template/content revisions.
Normal content updates preserve art. Reads, catalog thumbnails and actual-player
previews use the existing audience and membership-generation rules. Restricted
art remains online-only and cannot be placed until explicit all-player reveal.

Pending proposal art is visible only to its current authorized submitter and
GM/co-GM. The submitter may change it while the proposal is pending, with expected
proposal and independent image revisions and a scoped receipt. Proposal text and
its pending/terminal revision contract remain immutable. Approval also checks the
exact image revision the GM reviewed. Approval retains the proposal's exact safe
asset for the new template in the decision transaction. Withdrawal, denial or
membership revocation never grants a global route to its bytes. Existing ordinary
proposal/template request bodies cannot inject arbitrary image references.

## Placement and personal art

Placement resolves and pins the exact image descriptor from the selected system
package or campaign template revision into the server-owned character entry.
Client add-entry inputs cannot supply snapshots or image descriptors. A placed
image is served under the character and entry IDs, with current sheet authority;
it never requires renewed read access to a former campaign catalog or source
system. Replacement/archive/audience narrowing of the source cannot change an
existing disclosed copy. Character adoption, return and ownership transfer retain
that disclosed art under current character authority.

Controllers and permitted GMs may replace/remove presentation on an individual
entry, using its independent image revision plus the observed character revision.
These commands do not occupy the sheet offline queue or change rules revisions.
The effective image is the placed descriptor unless a character-scoped override
explicitly replaces or removes it. Entry removal revokes its route; duplication
retains independent entry links. Other copies and their actions/quantities remain
unchanged. State-only character exports omit media bytes; full backup restores
metadata and the mounted private files together.

Item cards/details use lazy bounded thumbnails, descriptive alternatives, a larger
view and a stable placeholder without obscuring quantity, description or actions.
The bounded file-selection/description controls are shared with portraits, while
owning views keep revision, authority, retry and save lifetimes. Final acceptance
is the staged plan's GM/three-player immutable-placement and privacy journey,
plus creator publication/clone/import/export and offline/return checks.
