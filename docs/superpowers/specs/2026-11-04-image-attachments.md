# Image attachment contract — M0–M3

The owning Module authorizes every mutation, retry and byte read. Shared private
platform functions only validate, scan, normalize and store bytes; they confer
no access. Opaque asset identities are never public URLs or client paths.

| Parent | Manage | Read |
| --- | --- | --- |
| Character portrait | Current character controller or authorized GM/co-GM | Current sheet readers |
| System template art | System draft editors | Accessible draft/publication readers |
| Campaign template art | GM/co-GM under the template policy | Current catalog audience; proposals stay private |
| Personal or placed entry art | Character controller/authorized GM | Current sheet readers |
| Scene background | Campaign GM/co-GM | GM sanitized original; paired displays get only server-redacted derivatives |

Character portraits are character presentation, independent of the reserved
null-only rules image field. They do not require a system publication. Images
never grant sheet/catalog visibility or alter mechanics. Character ownership,
adoption, return, archive and recovery retain character-scoped attachments.

Input is PNG/JPEG/WebP, at most 5 MiB, one frame, at most 4096×4096 pixels. Strict
base64 bounds apply before allocation. Verify magic, actual decode and matching
type; scan original bytes through ClamAV, fail closed on any scanner failure,
then re-encode without metadata. Use bounded WebP thumbnails. Decode/metadata
normalization is not a substitute for malware scanning. A private network
ClamAV service is required for real uploads; deterministic clean/infected
adapters exist only in tests. No production bypass is permitted.

Media metadata lives with its parent in PostgreSQL; bytes live on a provisioned
volume. Use fresh server-generated storage keys and exclusive writes before
metadata commit. A failed attach removes only its own uncommitted file. Mutation
input hashes include original byte identity, description and expected parent
revision. Current authorization precedes replay; exact committed retries return
their result, changed input rejects, stale revisions preserve the old image.

Bound each owner/campaign to 100 MiB and 256 retained assets, counted atomically
with parent writes. Published and placed copies pin safe asset identity and
checksum. Retained copies are authorized through their new parent rather than
the former campaign catalog. No referenced bytes may be removed. Orphans from
crashes may be cleaned only after proving absence from all current and retained
references; conservative retention is preferable to deletion.

Initial image mutations are online-only. Safe character thumbnails may be held
only in the existing actor/character lifetime and purged with it; a placeholder
is sufficient offline. Campaign catalogs, originals and displays remain online
only. Missing files return a useful sanitized error without blocking play.
Portable system export must include a bounded checksummed safe-art manifest
or explicitly report missing art, never private URLs or credentials.

Background replacement uses the current scene revision and one atomic write
that fully conceals fog and clears tokens. Failed writes preserve the old scene;
in-use backgrounds cannot be destructively deleted. The confirmation UI states
the conceal/token reset. Keep the established display redaction and pairing.

Durability acceptance requires actual hosted write/read, redeploy/restart and
restoration of matching database metadata plus volume bytes. No migrations or
old-version conversion paths precede the first release tag.
