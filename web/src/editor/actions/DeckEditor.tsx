import { PACKAGE_LIMITS } from "@sweetroll/rules";

import { t } from "../../i18n/index.js";
import type { DeckV1, SystemDocumentV1 } from "../../state/documentReducer.js";
import { Button, FormField, NumberInput, Select } from "../../ui/index.js";
import { Disclosure } from "../../ui/Disclosure.js";
import { ReferenceDataEditor, type ReferenceDataV1 } from "../referenceData/ReferenceDataEditor.js";
import { nextScopedId } from "../sheet/slotTypes.js";
import actionStyles from "./RollActionEditor.module.css";

export type DrawActionV1 = { kind: "draw"; id: string; label: string; deckId: string; count: number };
export type ShuffleActionV1 = { kind: "shuffle"; id: string; label: string; deckId: string };
export type DeckActionV1 = DrawActionV1 | ShuffleActionV1;

/**
 * Card decks (design 6.4): a deck names the dataset whose records are its
 * cards. The cards themselves are edited with the dataset editor.
 */
export function DeckEditor({ decks, datasets, usedIds, onChange }: {
  decks: DeckV1[];
  datasets: ReferenceDataV1[];
  usedIds: Set<string>;
  onChange: (next: Pick<SystemDocumentV1, "referenceData"> & { decks: DeckV1[] }) => void;
}) {
  function addDeck() {
    const used = new Set(usedIds);
    const datasetId = nextScopedId(used, "cards");
    const cards: ReferenceDataV1 = {
      id: datasetId,
      label: t("editor.decks.newCards"),
      records: [{ id: "card_1", label: t("editor.decks.newCard"), values: {} }],
    };
    onChange({
      referenceData: [...datasets, cards],
      decks: [...decks, { id: nextScopedId(used, "deck"), label: t("editor.decks.new"), datasetId }],
    });
  }
  const replaceDeck = (next: DeckV1) =>
    onChange({ referenceData: datasets, decks: decks.map(deck => deck.id === next.id ? next : deck) });
  return (
    <Disclosure label={t("editor.decks.title")}>
      <p>{t("editor.decks.hint")}</p>
      <Button variant="secondary" onClick={addDeck} disabled={decks.length >= PACKAGE_LIMITS.decks} data-testid="decks-add">
        {t("editor.decks.add")}
      </Button>
      {decks.map((deck, index) => {
        const dataset = datasets.find(candidate => candidate.id === deck.datasetId);
        const count = dataset?.records.length ?? 0;
        return (
          <fieldset key={deck.id} data-path={`/decks/${index}`} data-testid={`deck-${deck.id}`}>
            <legend>{deck.label}</legend>
            <FormField label={t("editor.decks.label")}>
              <input value={deck.label} maxLength={120} required
                onChange={(event) => replaceDeck({ ...deck, label: event.target.value })} />
            </FormField>
            <Select
              label={t("editor.decks.dataset")}
              id={`deck-dataset-${deck.id}`}
              value={dataset === undefined ? "" : deck.datasetId}
              onChange={(event) => replaceDeck({ ...deck, datasetId: event.target.value })}
              options={[
                ...(dataset === undefined ? [{ value: "", label: t("editor.decks.dataset.empty") }] : []),
                ...datasets.map(candidate => ({ value: candidate.id, label: `${candidate.label} (${candidate.id})` })),
              ]}
            />
            <p role={count < 1 || count > PACKAGE_LIMITS.cardsPerDeck ? "alert" : undefined} data-testid={`deck-count-${deck.id}`}>
              {count < 1 || count > PACKAGE_LIMITS.cardsPerDeck
                ? t("editor.decks.countInvalid", { count: String(count), max: String(PACKAGE_LIMITS.cardsPerDeck) })
                : t("editor.decks.count", { count: String(count) })}
            </p>
            {dataset === undefined ? null : (
              <Disclosure label={t("editor.decks.cards")}>
                <ReferenceDataEditor
                  referenceData={dataset}
                  onChange={(next) => onChange({
                    decks,
                    referenceData: datasets.map(candidate => candidate.id === dataset.id ? next : candidate),
                  })}
                />
              </Disclosure>
            )}
            <Button variant="secondary" onClick={() => onChange({ referenceData: datasets, decks: decks.filter(candidate => candidate.id !== deck.id) })}>
              {t("editor.decks.remove")}
            </Button>
          </fieldset>
        );
      })}
    </Disclosure>
  );
}

export function DeckActionEditor({ action, decks, onChange }: {
  action: DeckActionV1;
  decks: DeckV1[];
  onChange: (next: DeckActionV1) => void;
}) {
  const known = decks.some(deck => deck.id === action.deckId);
  return (
    <section className={actionStyles.layout} data-testid={`deck-action-${action.id}`} aria-label={action.label}>
      <div className={actionStyles.row}>
        <div className={actionStyles.field}>
          <FormField label={t(action.kind === "draw" ? "editor.action.draw.label" : "editor.action.shuffle.label")}>
            <input type="text" value={action.label} maxLength={120}
              data-testid={`deck-action-label-${action.id}`}
              onChange={(event) => onChange({ ...action, label: event.target.value })} />
          </FormField>
        </div>
        <div className={actionStyles.field}>
          <Select
            label={t("editor.action.deck")}
            id={`deck-action-deck-${action.id}`}
            data-testid={`deck-action-deck-${action.id}`}
            value={known ? action.deckId : ""}
            onChange={(event) => onChange({ ...action, deckId: event.target.value })}
            options={[
              ...(known ? [] : [{ value: "", label: t("editor.action.deck.empty") }]),
              ...decks.map(deck => ({ value: deck.id, label: `${deck.label} (${deck.id})` })),
            ]}
          />
        </div>
        {action.kind === "draw" ? (
          <div className={actionStyles.field}>
            <NumberInput
              label={t("editor.action.draw.count")}
              id={`deck-action-count-${action.id}`}
              testId={`deck-action-count-${action.id}`}
              min={1}
              max={PACKAGE_LIMITS.cardsPerDraw}
              step={1}
              value={action.count}
              onChange={(value) => onChange({
                ...action,
                count: Math.min(PACKAGE_LIMITS.cardsPerDraw, Math.max(1, Math.round(value ?? 1))),
              })}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
