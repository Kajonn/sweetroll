# M1 character portraits

One optional portrait belongs to a character independently of rules image fields.
The portrait link has its own monotonic revision; image writes also require the
observed character revision and current read/edit authority. A portrait edit does
not change rules state or its revision, so image requests never occupy the sheet
offline queue or prevent unrelated play. Both revisions are checked at commit.

Characters owns immutable safe image assets, current portrait links and scoped
30-day command receipts. Upload scans/normalizes before writing fresh opaque
private files. One transaction reauthorizes, checks revisions/quotas, inserts the
asset/link and saves the exact response. Exact retries reauthorize before replay;
changed input rejects. Replacing/removing retains safe bytes conservatively and
revokes the former link's byte route. A late replay cannot overwrite a newer
portrait. An archived parent rejects image mutation.

`GET /characters/{id}/portrait` returns its revision and optional safe descriptor;
`PUT` uploads/attaches and `DELETE` removes with expected character/portrait
revisions and an idempotency key. Authorized full/thumbnail reads include both
character and asset IDs. They never grant access through a global asset URL.
Current sheet authority is checked before and after file I/O; membership changes
and attachment mutations use campaign-before-character lock order. System
authorship grants no character image access. Ownership transfer, adoption,
return and archive preserve the character link under its current authority.
Duplication retains a disclosed safe asset under the new character link.

The header provides a preview, description, upload/replace, exact-request retry,
discard selection, remove and larger view. Library/GM roster use lazy bounded
thumbnails, meaningful alternatives and a placeholder. Mutations require online
access. Image queries/late responses are scoped to the current actor/character
lifetime and disappear on unmount. Images use no-store and remain outside the
service worker cache; offline sheets show a placeholder and keep normal play.
The existing state-only character export does not embed media; backup restores
image metadata and private bytes together.
