import type { Pool } from "pg";
import type { SceneEventHub } from "./scene-events.js";
import { canReadRoll, type MembershipRecord } from "./policy.js";
import type { RollAudience } from "../characters/persistence.js";
import type { Settlement } from "../characters/physical-rolls.js";
import type { PhysicalDie } from "../systems/physical-dice/resolution.js";
import type { DiceLaunch } from "../systems/physical-dice/launch.js";

export type RollStarted = {
  attemptId: string;
  actorId: string;
  characterId: string;
  expiresAt: string;
  launch: DiceLaunch;
  color: string;
  dice: PhysicalDie[];
};
export type RollFinished = Settlement & { attemptId: string; rollId: string };

type VisibleRoll = {
  id: string;
  actorId: string;
  characterId: string;
  principalId: string;
  audience: RollAudience;
  expiresAt: string;
  launch: DiceLaunch;
  color: string;
  dice: PhysicalDie[];
  rollId: string | null;
  settled: Settlement | null;
};
type Snapshot = { generation: number; role: MembershipRecord["role"]; rolls: VisibleRoll[] };

// One statement covers both current membership and roll data, including
// shooter controls and pinned placement for pending throws.
async function readSnapshot(pool: Pool, campaignId: string, actorId: string, sessionId: string) {
  const {
    rows: [result],
  } = await pool.query<Snapshot>(
    `SELECT viewer.generation, viewer.role, COALESCE((
       SELECT jsonb_agg(attempt ORDER BY attempt."expiresAt", attempt.id) FROM (
         SELECT a.id, a.actor_id AS "actorId", a.character_id AS "characterId", a.expires_at AS "expiresAt",
           a.launch, a.color, a.preparation->'dice' AS dice, r.id AS "rollId", a.settled,
           COALESCE(r.audience, a.preparation->>'audience') AS audience,
           COALESCE(r.audience_actor_id::text,r.actor_id::text,a.preparation->>'principalId') AS "principalId"
         FROM physical_roll_attempts a
         JOIN characters c ON c.id=a.character_id
         JOIN campaign_members roller ON roller.campaign_id=a.campaign_id AND roller.user_id=a.actor_id
         LEFT JOIN character_rolls r ON r.execution_id=a.execution_id AND r.scope_campaign_id=a.campaign_id
         WHERE a.campaign_id=viewer.campaign_id AND a.expires_at > now()
           AND (r.id IS NOT NULL OR (
             a.execution_id IS NULL AND c.campaign_id=a.campaign_id AND c.lifecycle='active'
             AND c.placement_generation=(a.preparation->>'placement')::integer
             AND c.revision=(a.preparation#>>'{command,expectedRevision}')::integer
             AND roller.status='active' AND roller.generation=(a.preparation->>'generation')::integer
             AND (roller.role IN ('owner','co_gm') OR EXISTS (
               SELECT 1 FROM character_controllers cc WHERE cc.character_id=c.id AND cc.user_id=a.actor_id
             ))
             AND (a.preparation#>>'{command,audience}' IS NOT NULL
               OR a.preparation->>'defaultAudience'=g.roll_audience_default)
           ))
         ORDER BY a.expires_at DESC, a.id DESC LIMIT 64
       ) attempt
     ),'[]'::jsonb) AS rolls
     FROM campaign_members viewer
     JOIN campaigns g ON g.id=viewer.campaign_id AND g.status='active'
     WHERE viewer.campaign_id=$1 AND viewer.user_id=$2 AND viewer.status='active'
       AND EXISTS (
         SELECT 1 FROM sessions s WHERE s.id=$3 AND s.user_id=viewer.user_id
           AND s.revoked_at IS NULL AND s.expires_at > now()
       )`,
    [campaignId, actorId, sessionId],
  );
  if (!result) return null;
  const membership: MembershipRecord = {
    campaignId,
    userId: actorId,
    status: "active",
    role: result.role,
    generation: result.generation,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return {
    generation: result.generation,
    rolls: result.rolls.filter((row) =>
      canReadRoll({
        roll: { campaignId, actorId: row.principalId, audience: row.audience },
        membership,
      }),
    ),
  };
}

type Sink = { write(chunk: string): boolean; onDrain(callback: () => void): void; end(): void };
type OpenStream = { attach(sink: Sink): void; close(): void };
type OpenResult = { ok: true; value: OpenStream } | { ok: false; status: 404 | 429 | 503 };
function event(name: string, payload: unknown) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createPhysicalDiceStreams({
  pool,
  hub,
  refreshMs = 5000,
}: {
  pool: Pool;
  hub: SceneEventHub;
  refreshMs?: number;
}) {
  const connections = new Map<() => void, string>();
  return {
    close() {
      for (const close of connections.keys()) close();
    },
    async open(campaignId: string, actorId: string, sessionId: string): Promise<OpenResult> {
      if (
        connections.size >= 256 ||
        [...connections.values()].filter((actor) => actor === actorId).length >= 4
      )
        return { ok: false, status: 429 };
      let sink: Sink | undefined;
      let unsubscribe: (() => void) | null = null;
      let refresh: NodeJS.Timeout | undefined;
      let lease: NodeJS.Timeout | undefined;
      let stall: NodeJS.Timeout | undefined;
      let closed = false;
      let dirty = false;
      let loading = false;
      let initial: NonNullable<Awaited<ReturnType<typeof readSnapshot>>>;
      const sent = new Map<string, "started" | "finished">();
      function close() {
        if (closed) return;
        closed = true;
        connections.delete(close);
        unsubscribe?.();
        clearInterval(refresh);
        clearTimeout(lease);
        clearTimeout(stall);
        sink?.end();
      }
      function write(chunk: string) {
        if (!sink || stall || sink.write(chunk)) return;
        // A false write still accepted this message. Stop sending further
        // frames until the response drains, then reread the live projection.
        stall = setTimeout(close, 5000);
        stall.unref();
        sink.onDrain(() => {
          clearTimeout(stall);
          stall = undefined;
          void reload();
        });
      }
      function deliver(snapshot: typeof initial) {
        const active = new Set(snapshot.rolls.map((roll) => roll.id));
        for (const id of sent.keys()) {
          if (closed || stall) break;
          if (!active.has(id)) {
            sent.delete(id);
            write(event("roll.removed", { attemptId: id }));
          }
        }
        for (const roll of snapshot.rolls) {
          if (closed || stall) break;
          if (roll.rollId && roll.settled) {
            if (sent.get(roll.id) === "finished") continue;
            sent.set(roll.id, "finished");
            write(
              event("roll.finished", {
                ...roll.settled,
                attemptId: roll.id,
                rollId: roll.rollId,
              } satisfies RollFinished),
            );
          } else if (!sent.has(roll.id)) {
            sent.set(roll.id, "started");
            const { id: attemptId, actorId, characterId, expiresAt, launch, color, dice } = roll;
            write(
              event("roll.started", {
                attemptId,
                actorId,
                characterId,
                expiresAt,
                launch,
                color,
                dice,
              } satisfies RollStarted),
            );
          }
        }
      }
      async function reload() {
        dirty = true;
        if (!sink || loading || closed || stall) return;
        loading = true;
        try {
          do {
            dirty = false;
            const snapshot = await readSnapshot(pool, campaignId, actorId, sessionId);
            if (closed) return;
            if (!snapshot || snapshot.generation !== initial.generation) {
              write(event("revoked", {}));
              close();
              return;
            }
            if (!dirty) deliver(snapshot);
          } while (dirty && !closed && !stall);
        } catch {
          close();
        } finally {
          loading = false;
        }
      }
      connections.set(close, actorId);
      unsubscribe = hub.subscribe({
        onEvent(change) {
          if (
            change.campaignId === campaignId &&
            (change.kind === "physicalRoll" || change.kind === "campaign")
          )
            void reload();
        },
        onLost: close,
      });
      if (!unsubscribe) {
        close();
        return { ok: false, status: 503 };
      }
      try {
        const snapshot = await readSnapshot(pool, campaignId, actorId, sessionId);
        if (closed) return { ok: false, status: 503 };
        if (!snapshot) {
          close();
          return { ok: false, status: 404 };
        }
        initial = snapshot;
      } catch {
        close();
        return { ok: false, status: 503 };
      }
      return {
        ok: true,
        value: {
          attach(next) {
            if (closed || sink) {
              next.end();
              return;
            }
            sink = next;
            // If an access change arrived during setup, authorize a fresh read before writing.
            if (dirty) void reload();
            else deliver(initial);
            if (closed) return;
            refresh = setInterval(() => {
              write(": hb\n\n");
              void reload();
            }, refreshMs);
            lease = setTimeout(close, 60_000); // Refresh the HTTP session on reconnect.
            refresh.unref();
            lease.unref();
          },
          close,
        },
      };
    },
  };
}
export type PhysicalDiceStreams = ReturnType<typeof createPhysicalDiceStreams>;
