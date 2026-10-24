import { useEffect, useRef, useState } from "react";
import type { CharactersApi } from "../characters/api.js";
import type {
  CommandResult,
  PushOptionsResponse,
} from "../characters/types.js";
import { Button } from "../ui/index.js";
import { RollBreakdown } from "./RollBreakdown.js";
type Roll = NonNullable<CommandResult["roll"]>;
export type PushApi = Pick<CharactersApi, "pushOptions" | "readRoll">;
const reasons: Record<string, string> = {
  parent_consumed:
    "This roll already has a push. Open its latest child in Activity.",
  exhausted: "Maximum pushes reached.",
  successful_roll: "This policy does not allow pushing a successful roll.",
  no_eligible_dice:
    "No eligible dice remain. Empty and fully locked pools cannot be pushed.",
  source_unavailable: "The original action or item is no longer available.",
  rules_changed: "The character uses different rules from the saved roll.",
  archived:
    "Pushing is unavailable while the character or campaign is archived.",
  invalid_snapshot: "The saved pool cannot be safely pushed.",
};
export function PushPanel({
  roll,
  characterId,
  api,
  online,
  revision,
  disabled = false,
  onPush,
  onRefresh,
  onComplete,
}: {
  roll: Roll;
  characterId: string;
  api: PushApi;
  online: boolean;
  revision?: number | undefined;
  disabled?: boolean | undefined;
  onPush?: ((rollId: string) => Promise<void>) | undefined;
  onRefresh?: (() => Promise<void>) | undefined;
  onComplete?: (() => void) | undefined;
}) {
  const [options, setOptions] = useState<PushOptionsResponse["options"] | null>(
      null,
    ),
    [error, setError] = useState<string | null>(null),
    [hidden, setHidden] = useState(false),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [ancestor, setAncestor] = useState<Roll | null>(null);
  const ref = useRef<HTMLElement | null>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const id = roll.push?.rollId;
  useEffect(() => {
    let alive = true;
    setOptions(null);
    setHidden(false);
    setError(null);
    setAncestor(null);
    if (!online || !id)
      return () => {
        alive = false;
      };
    void api.pushOptions(characterId, id).then(
      (r) => {
        if (alive) setOptions(r.options);
      },
      (e) => {
        if (!alive) return;
        if ((e as { status?: number }).status === 404) setHidden(true);
        else
          setError(
            "Could not refresh push availability. Try again when connected.",
          );
      },
    );
    return () => {
      alive = false;
    };
  }, [api, characterId, id, revision, online, refresh]);
  if (!id) return <RollBreakdown roll={roll} />;
  if (hidden) return <p role="status">This roll is no longer available.</p>;
  const push = async () => {
    if (busy || disabled || !online || !options?.canPush || !onPush) return;
    ref.current?.focus();
    setBusy(true);
    setOptions(null);
    setError(null);
    try {
      await onPush(id);
      onComplete?.();
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : "Push could not be completed.",
        );
    } finally {
      if (mounted.current) {
        setBusy(false);
        setRefresh((n) => n + 1);
      }
    }
  };
  const view = async (rollId: string) => {
    setError(null);
    try {
      const result = await api.readRoll(characterId, rollId);
      if (mounted.current) setAncestor(result.roll);
    } catch {
      if (mounted.current) {
        setAncestor(null);
        setError("That earlier roll is no longer available.");
      }
    }
  };
  const refreshOptions = async () => {
    ref.current?.focus();
    try {
      await onRefresh?.();
      if (mounted.current) setRefresh((n) => n + 1);
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "Refresh failed.");
    }
  };
  const stale =
    revision !== undefined && options !== null && options.revision !== revision;
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label="Saved pool result"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
      data-testid="push-result"
      data-roll-id={id}
    >
      {online && !options && !error ? (
        <p role="status">Checking saved roll…</p>
      ) : (
        <>
          <p>{roll.output}</p>
          <p>Total: {roll.total}</p>
          <RollBreakdown roll={roll} />
        </>
      )}
      {!online ? <p>Connect to push. This is a cached result.</p> : null}
      {disabled ? (
        <p>
          Wait until editing is available and all pending changes have a known
          outcome.
        </p>
      ) : null}
      {stale ? <p>The character changed. Refresh before pushing.</p> : null}
      {options?.reason ? (
        <p role="status">
          {reasons[options.reason] ?? "Pushing is unavailable."}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {onPush ? (
        <Button
          variant="secondary"
          disabled={!online || disabled || busy || stale || !options?.canPush}
          onClick={() => void push()}
        >
          Push saved roll
        </Button>
      ) : null}
      {online ? (
        <Button
          variant="secondary"
          disabled={busy || disabled}
          onClick={() => void refreshOptions()}
        >
          Refresh push availability
        </Button>
      ) : null}
      {roll.push!.parentRollId ? (
        <Button
          variant="secondary"
          disabled={!online || busy}
          onClick={() => void view(roll.push!.parentRollId!)}
        >
          View parent roll
        </Button>
      ) : null}
      {roll.push!.rootRollId !== roll.push!.rollId &&
      roll.push!.rootRollId !== roll.push!.parentRollId ? (
        <Button
          variant="secondary"
          disabled={!online || busy}
          onClick={() => void view(roll.push!.rootRollId)}
        >
          View original roll
        </Button>
      ) : null}
      {ancestor ? (
        <section aria-label="Earlier roll">
          <p>{ancestor.output}</p>
          <RollBreakdown roll={ancestor} />
        </section>
      ) : null}
    </section>
  );
}
