import { useQueries } from "@tanstack/react-query";

import type { CharactersApi } from "../characters/api.js";
import type { ActivityEvent, CharacterSummary } from "../characters/types.js";
import { t } from "../i18n/index.js";
import { EmptyState, PageHeader, Panel } from "../ui/index.js";
import {
  flattenLibraryPages,
  useCharacterLibrary,
} from "./characterQueries.js";
import styles from "./PersonalActivity.module.css";

/**
 * Bounded fan-out: the first library page only, capped at 10 characters.
 * The library paginates (CHARACTER_LIBRARY_PAGE_LIMIT per page) and search
 * only covers loaded pages, so an unbounded fan-out would both over-fetch
 * and mislead; this feed honestly covers the first page and says nothing
 * about the rest.
 */
const PERSONAL_ACTIVITY_CHARACTER_LIMIT = 10;

export type PersonalActivityIdentity = {
  getActorId(): string | null;
  isOnline(): boolean;
  getGeneration?(): number;
};

export type PersonalActivityProps = {
  api: CharactersApi;
  identity: PersonalActivityIdentity;
};

type FeedItem = {
  event: ActivityEvent;
  character: CharacterSummary;
};

function mergeByTimestampDesc(groups: Array<{ character: CharacterSummary; events: ActivityEvent[] }>): FeedItem[] {
  return groups
    .flatMap(group => group.events.map(event => ({ event, character: group.character })))
    .sort((a, b) => (a.event.occurredAt < b.event.occurredAt ? 1 : a.event.occurredAt > b.event.occurredAt ? -1 : 0));
}

/**
 * Cross-character feed. Fans out the existing per-character `api.activity`
 * over the library ids — no new endpoint, no secrets beyond what each
 * activity call already authorizes.
 */
export function PersonalActivity({ api, identity }: PersonalActivityProps) {
  const actorId = identity.getActorId();
  const generation = identity.getGeneration?.() ?? 0;
  const online = identity.isOnline();
  const library = useCharacterLibrary(api, actorId, generation, {
    enabled: actorId !== null,
    online,
  });
  const characters = flattenLibraryPages(library.data).slice(0, PERSONAL_ACTIVITY_CHARACTER_LIMIT);
  const feeds = useQueries({
    queries: characters.map(character => ({
      queryKey: ["characters", "activity", actorId, generation, character.characterId],
      queryFn: () => api.activity(character.characterId, null),
      enabled: actorId !== null && online,
      staleTime: 30_000,
    })),
  });

  if (actorId === null) {
    return (
      <section aria-labelledby="personal-activity-title" data-testid="personal-activity">
        <h1 id="personal-activity-title">{t("player.activity.title")}</h1>
        <p role="status">{t("character.detail.signIn")}</p>
      </section>
    );
  }

  if (!online) {
    return (
      <div data-testid="personal-activity">
        <PageHeader title={t("player.activity.title")} description={t("player.activity.description")} />
        <p role="status">{t("character.tools.activityUnavailable")}</p>
      </div>
    );
  }

  const loading = library.isLoading || feeds.some(feed => feed.isLoading);
  if (loading) {
    return (
      <div data-testid="personal-activity">
        <PageHeader title={t("player.activity.title")} description={t("player.activity.description")} />
        <p role="status">{t("player.activity.loading")}</p>
      </div>
    );
  }

  if (library.isError || feeds.some(feed => feed.isError)) {
    return (
      <div data-testid="personal-activity">
        <PageHeader title={t("player.activity.title")} description={t("player.activity.description")} />
        <Panel>
          <p role="alert">{t("character.tools.activityFailed")}</p>
        </Panel>
      </div>
    );
  }

  const byId = new Map(characters.map(character => [character.characterId, character]));
  const items = mergeByTimestampDesc(
    feeds.flatMap((feed, index) => {
      const character = byId.get(characters[index]?.characterId ?? "");
      if (character === undefined || feed.data === undefined) return [];
      return [{ character, events: feed.data.events ?? [] }];
    }),
  );

  return (
    <div data-testid="personal-activity">
      <PageHeader title={t("player.activity.title")} description={t("player.activity.description")} />
      {items.length === 0 ? (
        <Panel>
          <EmptyState title={t("player.activity.empty")} description={t("player.activity.emptyHint")} />
        </Panel>
      ) : (
        <Panel>
          <ul className={styles.feed}>
            {items.map(({ event, character }) => (
              <li
                key={`${character.characterId}:${event.id}`}
                className={styles.row}
                data-testid={`activity-item-${event.id}`}
              >
                <a
                  href={`/characters/${character.characterId}`}
                  className={styles.rowLink}
                  aria-label={t("player.library.open", { name: character.name })}
                >
                  {character.name}
                </a>{" "}
                <span>{event.kind}</span>{" "}
                <span>{t("character.tools.activitySummary", { revision: event.characterRevision, time: event.occurredAt })}</span>{" "}
                <time dateTime={event.occurredAt}>{event.occurredAt}</time>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
