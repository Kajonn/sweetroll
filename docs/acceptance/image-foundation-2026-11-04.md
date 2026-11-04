# M0 image foundation — 2026-11-04

Implementation in progress; hosted durability acceptance is pending.

Red: the new five-case database suite failed four cases against the prior
implementation: metadata remained, scanner outcomes were ignored, quotas were
absent and referenced backgrounds could be deleted. The authorization case
already returned 404. Processing and scanner-adapter tests first failed for
missing capabilities, then passed (9 processing + 4 protocol tests).

Green: the new database suite and the existing scene/display suite passed all
33 cases. The missing-background corruption regression now first proves that
API deletion is blocked, then explicitly removes test bytes to exercise the
existing fail-closed display behavior. It does not weaken deletion protection.
The additional backup/restore case passed (6/6 foundation cases) and restores the same row identity/checksum and
private file bytes in a real local PostgreSQL/filesystem fixture. No old-format
conversion or migration is involved.

The isolated `sweetroll-d2-acceptance`/`preview` environment has a private
`sweetroll-image-scanner` service (`4e190ef0-8aab-45c3-92ba-f5c782cddd5c`),
official `clamav/clamav:1.4`, a signature volume and no public domain/TCP proxy.
Deployment `2d4cbb8a-0c42-4ae7-a9b2-0ba214559e19` reached SUCCESS and logs confirmed
ClamD started. Image uploads fail closed when its configured adapter is absent.

Before accepting M0, record the application commit/deployment, mounted media
volume, actual clean/infected upload results, scoped unauthorized reads, exact
retry, post-redeploy byte identity and the restoration result. M1–M3 cannot be
marked complete from this foundation work. Existing human/device G9 gates remain.
