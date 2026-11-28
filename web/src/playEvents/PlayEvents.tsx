import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CommandResultResponse, CharacterView } from "../characters/types.js";
import { t } from "../i18n/index.js";
import { SystemPresentationScope } from "../theme/SystemPresentation.js";
import { createEventStack, FADE_MS, FRESH_MS, type PlayEvent } from "./stack.js";
import styles from "./PlayEvents.module.css";

const OverlayTarget = createContext<HTMLElement | null>(null);

export function PlayEventHost({ children, lifetime }: { children: ReactNode; lifetime: string | null }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const header = target?.closest("[data-testid=app-shell]")?.querySelector("header");
    if (!target || !header) return;
    const place = () => target.style.setProperty("--play-events-top", `${header.getBoundingClientRect().height + 8}px`);
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(header);
    return () => observer.disconnect();
  }, [target]);
  return <OverlayTarget.Provider value={target}>
    {children}
    {lifetime === null ? null : <div key={lifetime} ref={setTarget} />}
  </OverlayTarget.Provider>;
}

function fadeDuration() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : FADE_MS;
}

export function usePlayEvents(scope: string | null) {
  const target = useContext(OverlayTarget);
  const stack = useMemo(createEventStack, [scope, target]);
  const [rendered, setRendered] = useState(() => ({ stack, view: stack.snapshot(Date.now()) }));
  const view = rendered.stack === stack ? rendered.view : stack.snapshot(Date.now());
  const [announcement, setAnnouncement] = useState<{ text: string; id: number; stack: typeof stack } | null>(null);
  const announcementId = useRef(0);
  const pending = useRef<string[]>([]);
  const active = useRef<typeof stack | null>(null);
  const announceTimer = useRef<number | undefined>(undefined);
  const refresh = useCallback(() => setRendered({ stack, view: stack.snapshot(Date.now(), fadeDuration()) }), [stack]);

  useLayoutEffect(() => {
    active.current = target !== null && scope !== null ? stack : null;
    return () => {
      active.current = null;
      window.clearTimeout(announceTimer.current);
      announceTimer.current = undefined;
      pending.current = [];
    };
  }, [scope, stack, target]);

  useEffect(() => {
    if (view.next === undefined) return;
    const timer = window.setTimeout(refresh, Math.max(0, view.next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [view.next, refresh]);

  const resetAnnouncement = useCallback(() => {
    window.clearTimeout(announceTimer.current);
    announceTimer.current = undefined;
    pending.current = [];
    setAnnouncement(null);
  }, []);

  const publish = useCallback((events: readonly PlayEvent[]) => {
    if (active.current !== stack || events.length === 0 || document.visibilityState === "hidden") return;
    const added = stack.add(events, Date.now(), fadeDuration());
    if (added.length === 0) return;
    refresh();
    pending.current.push(...added);
    if (announceTimer.current !== undefined) return;
    announceTimer.current = window.setTimeout(() => {
      const messages = pending.current;
      pending.current = [];
      announceTimer.current = undefined;
      setAnnouncement({ stack, id: ++announcementId.current, text: messages.length > 3 ? t("playEvents.burst", { count: messages.length }) : messages.join(". ") });
    }, 150);
  }, [stack, refresh]);

  const clear = useCallback(() => {
    stack.clear();
    resetAnnouncement();
    refresh();
  }, [stack, refresh, resetAnnouncement]);

  const retainAuthorized = useCallback((authorized: string[], checked: string[]) => {
    if (!stack.retainAuthorized(authorized, checked)) return;
    resetAnnouncement();
    refresh();
  }, [stack, refresh, resetAnnouncement]);

  return { target, view, announcement: announcement?.stack === stack ? announcement : null, publish, clear, retainAuthorized, watched: stack.watched };
}

export type PlayEvents = ReturnType<typeof usePlayEvents>;

export function PlayEventOverlay({ events, presentation }: {
  events: PlayEvents;
  presentation?: NonNullable<CharacterView["projection"]>["presentation"];
}) {
  if (events.target === null) return null;
  return createPortal(
    <SystemPresentationScope presentation={presentation} className={styles.overlay}>
      {events.view.cards.length === 0 ? null : (
        <ul aria-label={t("playEvents.label")} className={styles.stack} data-testid="play-events">
          {events.view.cards.map(card => (
            <li key={card.id} className={styles.card} data-fading={card.fading}>{card.text}</li>
          ))}
          {events.view.overflow > 0 ? (
            <li className={styles.overflow}>{t("playEvents.overflow", { count: events.view.overflow })}</li>
          ) : null}
        </ul>
      )}
      <div className={styles.announcement} role="status" aria-atomic="true">
        {events.announcement ? <span key={events.announcement.id}>{events.announcement.text}</span> : null}
      </div>
    </SystemPresentationScope>,
    events.target,
  );
}

type RollAudience = NonNullable<CommandResultResponse["result"]["roll"]>["audience"];

export function rollText(actor: string, kind: "roll" | "push" | "draw", audience: RollAudience, result: string | number) {
  return t(`playEvents.${kind}`, { actor, result, audience: t(`character.rollResult.audience.${audience}`) });
}

export type PublishCommand = (response: CommandResultResponse, startedAt: string, actionLabel?: string) => void;

export function commandEvent(response: CommandResultResponse, startedAt: string, actionLabel?: string): PlayEvent | undefined {
  const { roll, rollId, character } = response.result;
  if (!roll || !rollId || !(Date.now() - Date.parse(startedAt) <= FRESH_MS)) return undefined;
  const actor = t("campaign.detail.activity.actor.you");
  const drawn = roll.breakdown.cards?.drawn;
  const outcome = roll.outcome ? ` · ${roll.outcome.label}` : "";
  const text = drawn?.length
    ? rollText(actor, "draw", roll.audience, drawn.map(card => card.label).join(", "))
    : rollText(actor, roll.push?.parentRollId ? "push" : "roll", roll.audience, `${roll.total}${outcome}`);
  return {
    id: `roll:${rollId}`,
    text: actionLabel ? `${text} · ${actionLabel}` : text,
    watch: character.campaignId != null,
  };
}
