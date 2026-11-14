export const HOLD_MS = 6000;
export const FADE_MS = 240;
export const FRESH_MS = 15_000;
const VISIBLE_LIMIT = 3;
const OVERFLOW_LIMIT = 21;
const SEEN_MS = 2 * FRESH_MS;

export type PlayEvent = { id: string; text: string; watch?: boolean };
type TimedEvent = PlayEvent & { expires: number };
type View = {
  cards: Array<PlayEvent & { fading: boolean }>;
  overflow: number;
  next: number | undefined;
};

export function createEventStack() {
  let visible: TimedEvent[] = [];
  let overflow: TimedEvent[] = [];
  const seen = new Map<string, number>();

  function advance(now: number, fade: number) {
    visible = visible.filter(card => card.expires + fade > now);
    overflow = overflow.filter(card => card.expires > now);
    while (visible.length < VISIBLE_LIMIT) {
      const next = overflow.shift();
      if (next === undefined) break;
      visible.push(next);
    }
  }

  return {
    add(events: readonly PlayEvent[], now: number, fade = FADE_MS): string[] {
      advance(now, fade);
      for (const [id, until] of seen) {
        if (until > now) break;
        seen.delete(id);
      }
      const added = [];
      for (const event of events) {
        if (seen.has(event.id)) continue;
        seen.set(event.id, now + SEEN_MS);
        const card = { ...event, expires: now + HOLD_MS };
        if (visible.length < VISIBLE_LIMIT) visible.push(card);
        else if (overflow.length < OVERFLOW_LIMIT) overflow.push(card);
        added.push(event.text);
      }
      return added;
    },
    snapshot(now: number, fade = FADE_MS): View {
      advance(now, fade);
      const deadlines = [...visible, ...overflow].map(card =>
        card.expires > now ? card.expires : card.expires + fade,
      );
      return {
        cards: visible.slice().reverse().map(card => ({ ...card, fading: card.expires <= now })),
        overflow: overflow.length,
        next: deadlines.length === 0 ? undefined : Math.min(...deadlines),
      };
    },
    watched(now: number): string[] {
      return [...visible, ...overflow].filter(card => card.watch && card.expires + FADE_MS > now).map(card => card.id);
    },
    retainAuthorized(authorized: readonly string[], checked: readonly string[]): boolean {
      const previous = visible.length + overflow.length;
      const keep = (card: TimedEvent) => !checked.includes(card.id) || authorized.includes(card.id);
      visible = visible.filter(keep);
      overflow = overflow.filter(keep);
      return visible.length + overflow.length !== previous;
    },
    clear() {
      visible = [];
      overflow = [];
    },
  };
}
