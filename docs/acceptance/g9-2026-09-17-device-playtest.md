# G9 owner-gated re-verification + device/playtest protocol (2026-09-17)

Scope: doc-only. No device, playtest, deployment, or production-auth claims are
closed by this record. Every owner-gated item below stays blocked until the
owner supplies the decision, device, or host. Task 6 consumes the dated
statuses plus the runnable playtest script.

## Mockup recheck

Command (run 2026-09-17 in the Task 5 worktree):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site; date -u +%F
```

Result:

```text
401
2026-09-17
```

Status: still blocked HTTP 401, re-verified 2026-09-17 (previously blocked
2026-09-09 per GUI plan G0). `docs/ui/reference/` stays empty; no
palette/typography/spacing values invented. Representative mockup capture
requires the owner to republish the mockup or supply captures
(release-gates reference gate).

## OD-08 launch templates

Design §6.7/§17.9 reference fixtures (license-neutral original work, not
shipped launch templates):

1. d20 ability/check family
2. 2d6 PbtA-style move family
3. d6 counted-success pool family

No shipped open-license template claimed — license review outstanding

Template selection/license review remains open before any shipped-template
claim or acceptance requiring licensed launch templates (design §18.1 OD-08,
deferred 2026-09-09).

## Production auth

OD-05 deferred: no new production service, cloud resource, or OIDC provider
in this plan; production auth stays owner-deferred.

Done: test/prod separation via `resolveAuthMode`
(`src/transport/http/dev-signin.ts`, `src/bootstrap/http.ts`): `/dev/*`
registers only when non-production or explicit `SWEETROLL_TEST_AUTH=1`, with
a startup log line stating the active auth mode.

Still open — real-provider sign-in acceptance per release-gates Task 4
(authentication gate), exact wording:

- real provider sign-in/return,
- concurrent first sign-in yielding one user,
- expired sessions,
- revocation and secure sign-out.

Requires the owner to reopen the production-provider decision (issuer,
intended deployment origin, callback/logout requirements) plus a separately
approved production auth plan using the existing Identity port. Do not commit
client secrets.

## Device matrix

No device runs claimed. Emulated widths are not replacements for real-device
checks (release-gates Task 3).

| Device | OS | Browser | Theme | Width | Result |
|--------|----|---------|-------|-------|--------|

Owner-assisted protocol when devices are available: real Android Chrome and
iPad Safari in portrait/landscape, touch, virtual keyboard, installed PWA;
record actual OS/browser/device versions plus installation/reopening
evidence. Verify each migrated route at phone/tablet/desktop widths,
light/dark, 200% text enlargement, long translated labels, keyboard, and
touch. Require human contrast/visual review in both themes with screenshots;
do not claim the unavailable mockup's typography/palette has been validated.

## Playtest script

Run before public release, after I7b (release-gates playtest gate). Close
blocking usability, data-loss, and disclosure findings before declaring
acceptance.

Session A — physical table (one session):

1. GM on a phone runs setup, members, content/Hidden, Session board.
2. Players join on phones: accept invitation, create or claim a campaign
   character, use the sheet, read only permitted content, make a
   campaign-visible roll.
3. A separate restricted tablet displays the shared scene: reveal/conceal
   fog, place/move tokens, change scene, reconnect, revoke the display.
4. GM removes a grant / revokes a membership mid-session; confirm purged
   views, caches, and no resurrection via Back, refresh, offline reopening,
   or delayed pre-revocation responses.

Session B — remote (one session, four players):

1. Same player journey over remote connections: invite → claim → sheet →
   permitted content → campaign-visible roll.
2. Remote player views the same permitted scene on a separate restricted
   display; repeat reveal/conceal, token move, scene change, reconnect,
   revoke.
3. Exercise sign-in return and deep-link refresh on the built artifact (no
   Vite dev/preview).

Capture for both sessions: usability findings, data-loss findings,
disclosure findings (GM originals/secrets must be absent from display
network responses, storage, reloads, and direct requests). Previously
revealed information cannot be made unseen; conceal/revoke prevents
subsequent access, not screenshots already taken. Before I7b, two
authenticated GM devices can prove I7 behavior, not restricted display
security.

## Built-artifact check

Against the Task 4 single-artifact image (built `web/dist` served by the
Fastify app with SPA fallback excluding `/api`, `/metrics`, `/health/*`):

1. Deep-link refresh (e.g. a campaign route) returns the app shell.
2. Sign-in return (`/cb` → pre-sign-in path) works on the built artifact.
3. Fully offline shell reopening works without Vite dev/preview.

Run only after Task 4 lands; record the image tag/commit, exact commands,
and verbatim `ui`/`api` curl output in the Task 6 acceptance record. A bare
`docker build` success alone does not close this gate.
