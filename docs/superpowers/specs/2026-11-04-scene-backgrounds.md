# M3 scene backgrounds

M2 passed hosted acceptance on `dafdcff` and CI #210 before M3 began.
The existing Campaigns media uploader, scene mutations, fog/token controls and
restricted display remain the implementation. Inventory found no reachable
scene upload/select UI: the empty scene route only shows an empty state, upload
and create/update wrappers have no UI consumers, and no bounded image/scene
catalog endpoints exist. Background replacement also preserves the prior fog and
tokens. These are the concrete gaps this stage closes.

A background change atomically updates its reference, resets fog to fully
concealed and clears tokens under the same expected scene revision. Re-selecting
the same file preserves fog and tokens. Invalid/foreign/stale writes leave the
entire scene unchanged. Changing the background also remounts the viewport and
fog/token controls, discarding uncommitted coordinates and zoom from the old
image. Existing referenced-file deletion protection remains.
The GM confirms the actual observed scene/image before replacement; concurrent
fog/token changes require explicit refresh and renewed confirmation. Lost
responses retain the exact frozen request for retry.

Campaigns adds GM-only, no-store metadata catalogs for images and scenes, with
UUID keyset cursors, 25 default/50 maximum rows and no filesystem/storage keys.
An authorized thumbnail read resizes already scanned safe media to the shared
256px/64KiB WebP bound; it performs current-policy checks before and after I/O
and verifies the stored original checksum. No new cache or database migration
is needed. Thumbnail work is bounded and does not return private originals.

The existing scene route gains upload, named thumbnails, choose/create/open,
confirmed replace and explicit deletion with in-use errors. The shared bounded
file fields are reused. Uploading or creating never presents an image to a
display automatically. Scenes retain their existing identity and are identified
in the picker by their background name; general scene renaming/editors are outside
this stage. Uploads and all library writes remain online-only. Account/generation
changes remount and purge library queries and pending UI work.

Displays keep credential-only requests, server-rendered pixel redaction,
visible-and-revealed tokens, revision-keyed images, revoke/reconnect/offline blanking
and private-device handoff. No system/item/portrait bytes are admitted to display
credentials. Hosted acceptance exercises GUI upload/create/replace, stale GM
writes, exact redacted pixels, token reset, private original denial, reconnect,
revoke and post-redeploy byte retention. Physical devices and human/table-play
G9 gates remain open.
