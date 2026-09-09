import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { CharactersApi } from "../characters/api.js";
import type { CharacterSummary } from "../characters/types.js";
import { t } from "../i18n/index.js";
import { Button, EmptyState, FormField, PageHeader, Panel, Select } from "../ui/index.js";
import fieldStyles from "../ui/fields.module.css";
import {
  CHARACTER_LIBRARY_RECENT_COUNT,
  characterLibraryKey,
  filterLibraryByLifecycle,
  filterLibraryCharacters,
  flattenLibraryPages,
  recentLibraryCharacters,
  useCharacterLibrary,
} from "./characterQueries.js";
import styles from "./CharacterLibrary.module.css";

export type CharacterLibraryIdentity = {
  getActorId(): string | null;
  isOnline(): boolean;
  getGeneration?(): number;
};

export type CharacterLibraryNavigation = {
  onOpenCharacter(characterId: string): void;
  onCreateNew(): void;
};

export type CharacterLibraryProps = {
  api: CharactersApi;
  identity: CharacterLibraryIdentity;
  navigation?: CharacterLibraryNavigation | undefined;
};

type LifecycleFilter = "all" | "active" | "archived";

function openedStorageKey(actorId: string): string {
  return `sweetroll.library.recent:${actorId}`;
}

function readOpenedIds(actorId: string | null): string[] {
  if (actorId === null || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(openedStorageKey(actorId));
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Personal character library. Links to `/characters/new` and the character
 * detail route for creation and archive/recover — the creation seam
 * (`CreateCharacter` + creation-options) and the management dialogs in
 * `CharacterTools` are reused, never rebuilt here. Soft-delete is the
 * existing `archived_at` lifecycle; this view only reads it.
 */
export function CharacterLibrary({ api, identity, navigation }: CharacterLibraryProps) {
  const actorId = identity.getActorId();
  const generation = identity.getGeneration?.() ?? 0;
  const online = identity.isOnline();
  const queryClient = useQueryClient();
  const library = useCharacterLibrary(api, actorId, generation, { enabled: true, online });

  const [searchInput, setSearchInput] = useState("");
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>("all");
  const [openedIds, setOpenedIds] = useState<string[]>(() => readOpenedIds(actorId));
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  if (actorId === null) {
    return (
      <section aria-labelledby="character-library-title" className={styles.library} data-testid="character-library">
        <h1 id="character-library-title">{t("player.library.title")}</h1>
        <p role="status">{t("character.detail.signIn")}</p>
      </section>
    );
  }

  const characters = flattenLibraryPages(library.data);
  const visible = filterLibraryByLifecycle(filterLibraryCharacters(characters, searchInput), lifecycle);
  const recent = recentLibraryCharacters(characters, openedIds, CHARACTER_LIBRARY_RECENT_COUNT);
  const showSearchNote = searchInput.trim() !== "" && library.hasNextPage === true;

  const markOpened = (characterId: string) => {
    setOpenedIds((current) => {
      const next = [characterId, ...current.filter((id) => id !== characterId)].slice(0, 10);
      try {
        localStorage.setItem(openedStorageKey(actorId), JSON.stringify(next));
      } catch {
        // Recently-opened is a best-effort convenience; storage failures
        // must not break navigation.
      }
      return next;
    });
  };

  const openCharacter = (characterId: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    markOpened(characterId);
    if (navigation === undefined) return;
    event.preventDefault();
    navigation.onOpenCharacter(characterId);
  };

  const createNew = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (navigation === undefined) return;
    event.preventDefault();
    navigation.onCreateNew();
  };

  const duplicateCharacter = async (character: CharacterSummary) => {
    if (duplicatingId !== null) return;
    setDuplicatingId(character.characterId);
    setDuplicateError(null);
    try {
      // The API seam never mints idempotency keys: the caller owns the key.
      const response = await api.duplicateCharacter(character.characterId, {
        idempotencyKey: crypto.randomUUID(),
      });
      markOpened(response.character.characterId);
      await queryClient.invalidateQueries({ queryKey: characterLibraryKey(actorId, generation) });
    } catch (error) {
      setDuplicateError(error instanceof Error && error.message ? error.message : t("player.library.duplicateFailed"));
    } finally {
      setDuplicatingId(null);
    }
  };

  return (
    <div className={styles.library} data-testid="character-library">
      <PageHeader
        title={t("player.library.title")}
        description={t("player.library.description")}
        actions={
          <a href="/characters/new" onClick={createNew} data-testid="character-library-create" className={styles.createLink}>
            {t("player.library.create")}
          </a>
        }
      />
      {library.isLoading ? <p role="status">{t("player.library.loading")}</p> : null}
      {library.isError ? (
        <Panel>
          <p role="alert">{t("player.library.loadFailed")}</p>
          <p>{t("player.library.retryHint")}</p>
          <Button type="button" variant="secondary" onClick={() => void library.refetch()}>
            {t("player.library.retry")}
          </Button>
        </Panel>
      ) : null}
      {!library.isLoading && !library.isError && characters.length === 0 ? (
        <Panel title={t("player.library.listHeading")}>
          <EmptyState
            title={t("player.library.empty")}
            description={t("player.library.emptyHint")}
            action={
              <a href="/characters/new" onClick={createNew} className={styles.createLink}>
                {t("player.library.create")}
              </a>
            }
          />
        </Panel>
      ) : null}
      {!library.isLoading && !library.isError && characters.length > 0 ? (
        <>
          <Panel title={t("player.library.recentHeading")}>
            <ul className={styles.recentList} aria-label={t("player.library.recentHeading")}>
              {recent.map((character) => (
                <li key={character.characterId}>
                  <a
                    href={`/characters/${character.characterId}`}
                    onClick={openCharacter(character.characterId)}
                    className={styles.rowLink}
                  >
                    {character.name}
                  </a>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title={t("player.library.listHeading")}>
            <FormField label={t("player.library.searchLabel")}>
              <input
                type="search"
                className={fieldStyles.input}
                placeholder={t("player.library.searchPlaceholder")}
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                data-testid="character-library-search"
              />
            </FormField>
            <Select
              label={t("player.library.lifecycleLabel")}
              value={lifecycle}
              onChange={(event) => setLifecycle(event.target.value as LifecycleFilter)}
              options={[
                { value: "all", label: t("player.library.lifecycle.all") },
                { value: "active", label: t("player.library.lifecycle.active") },
                { value: "archived", label: t("player.library.lifecycle.archived") },
              ]}
              data-testid="character-library-lifecycle"
            />
            {duplicateError !== null ? <p role="alert">{duplicateError}</p> : null}
            {visible.length === 0 ? (
              <EmptyState title={t("player.library.noMatch")} description={t("player.library.manageHint")} />
            ) : (
              <ul className={styles.rowList}>
                {visible.map((character) => (
                  <li
                    key={character.characterId}
                    className={styles.row}
                    data-testid={`library-row-${character.characterId}`}
                  >
                    <a
                      href={`/characters/${character.characterId}`}
                      onClick={openCharacter(character.characterId)}
                      className={styles.rowLink}
                      aria-label={t("player.library.open", { name: character.name })}
                    >
                      <span className={styles.rowName}>{character.name}</span>
                      <span className={styles.rowMeta}>
                        {t(
                          character.lifecycle === "archived"
                            ? "player.library.lifecycleArchived"
                            : "player.library.lifecycleActive",
                        )}
                      </span>
                    </a>
                    <Button
                      type="button"
                      variant="secondary"
                      pending={duplicatingId === character.characterId}
                      pendingText={t("player.library.duplicating")}
                      disabled={duplicatingId !== null}
                      onClick={() => void duplicateCharacter(character)}
                      aria-label={t("player.library.duplicateNamed", { name: character.name })}
                      data-testid={`library-duplicate-${character.characterId}`}
                    >
                      {t("player.library.duplicate")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {showSearchNote ? <p className={styles.note}>{t("player.library.searchPartial")}</p> : null}
            {library.hasNextPage === true ? (
              <Button
                type="button"
                variant="secondary"
                pending={library.isFetchingNextPage}
                pendingText={t("player.library.loading")}
                onClick={() => void library.fetchNextPage()}
                data-testid="character-library-load-more"
              >
                {t("player.library.loadMore")}
              </Button>
            ) : null}
            <p className={styles.note}>{t("player.library.manageHint")}</p>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
