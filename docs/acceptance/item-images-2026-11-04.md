# Item images — implementation checkpoint

M2 is implemented locally; hosted acceptance and branch CI remain pending. This
record does not mark the stage accepted or the full PR complete.

The module/HTTP cases began red with missing image routes. They now cover system
publication, later draft replacement, clone, complete export/import with rescan,
foreign asset denial, campaign audiences and membership generations, private
proposal art with exact reviewed-image approval, retained placed copies after
catalog narrowing/replacement and character return, per-entry overrides, replay,
duplication and removed-entry identity reuse. A paused duplication test reproduced
a stale rules snapshot before its revision guard was added. A contradictory shared
file descriptor imported successfully before the complete manifest check was added.

Local validation:
- Root type check and 488 unit cases passed (10 database cases skipped in that command).
- Database suite: 388 passed; one schema inventory expectation missed the newly
  created primary-key index. The corrected current-schema suite passed all 11 cases.
  The unchanged session-burst budgets passed (creation p95 228 ms, reads 16.3 ms,
  bumps 21.2 ms and rolls 22.3 ms).
- Full web suite passed 1,206 cases before the final two retry/approval cases;
  subsequent focused checks include those cases. Type check and production build passed.
- Shared editor red/green cases cover exact retries across parent edits,
  malformed successes and disconnect/reconnect, offline privacy and independent play.
- Generated contracts check passed; the generator's output buffer now supports
  the larger complete API without truncating its generated client declarations.

The dedicated hosted runner uses one GM and three player sessions. Setup and
cleanup use normal application APIs; artwork upload/edit, reviewed approval and
sheet play use the routed GUI. It will exercise three published template images,
clone/import/export, personal overrides, private catalog audiences/previews,
proposal privacy, retained copies, offline edits and return. Actual deployment,
results and screenshots will be recorded after it runs.

Only the isolated branch preview is used. A new disposable database preserves
all earlier preview databases. Production sources and migration policy are unchanged.
