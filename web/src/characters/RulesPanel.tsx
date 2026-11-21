import { useMemo, useState } from "react";

import { t } from "../i18n/index.js";
import { Button, Select } from "../ui/index.js";
import type { CharactersApi } from "./api.js";
import styles from "./characters.module.css";

type Dataset = { datasetId: string; label: string; records: Array<{ id: string; label: string; values: Record<string, string | number | boolean | null> }> };

/**
 * Design 6.1 (SRD gaps S2): the system's reference tables, such as rules text,
 * conditions or spells, readable by everyone who can read this sheet.
 * Loaded on request; the search runs on the loaded table.
 */
export function RulesPanel({ characterId, api }: { characterId: string; api: Pick<CharactersApi, "referenceData" | "referenceDataset"> }) {
  const [tables, setTables] = useState<Array<{ datasetId: string; label: string; records: number }> | null>(null);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [search, setSearch] = useState("");
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (dataset === null) return [];
    return dataset.records.filter((record) => needle === "" || record.label.toLowerCase().includes(needle)
      || Object.values(record.values).some((value) => typeof value === "string" && value.toLowerCase().includes(needle))).slice(0, 50);
  }, [dataset, search]);
  if (api.referenceData === undefined || api.referenceDataset === undefined) return null;
  const load = async (run: () => Promise<void>) => {
    setLoading(true);
    setFailed(false);
    try { await run(); } catch { setFailed(true); } finally { setLoading(false); }
  };
  return (
    <section className={styles.rulesPanel} aria-label={t("character.rules.title")} data-testid="rules-panel">
      <h2>{t("character.rules.title")}</h2>
      {tables === null ? (
        <Button variant="secondary" disabled={loading} onClick={() => void load(async () => setTables((await api.referenceData!(characterId)).datasets))}>
          {t("character.rules.open")}
        </Button>
      ) : tables.length === 0 ? <p>{t("character.rules.empty")}</p> : (
        <Select
          label={t("character.rules.table")}
          value={dataset?.datasetId ?? ""}
          disabled={loading}
          data-testid="rules-panel-table"
          options={[{ value: "", label: t("character.rules.chooseTable") },
            ...tables.map((table) => ({ value: table.datasetId, label: `${table.label} (${table.records})` }))]}
          onChange={(event) => {
            const datasetId = event.target.value;
            setSearch("");
            if (datasetId === "") { setDataset(null); return; }
            void load(async () => setDataset((await api.referenceDataset!(characterId, datasetId)).dataset));
          }}
        />
      )}
      {failed ? <p role="alert">{t("character.rules.failed")}</p> : null}
      {dataset !== null ? <>
        <label className={styles.field}>
          {t("character.rules.search")}
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} data-testid="rules-panel-search" />
        </label>
        <ul className={styles.rulesList}>
          {matches.map((record) => (
            <li key={record.id}>
              <details>
                <summary>{record.label}</summary>
                {Object.entries(record.values).filter(([, value]) => value !== null && value !== "").map(([column, value]) => (
                  <p key={column} className={styles.personalText}><strong>{column}: </strong>{String(value)}</p>
                ))}
              </details>
            </li>
          ))}
        </ul>
        {matches.length === 50 ? <p>{t("character.rules.more")}</p> : null}
      </> : null}
    </section>
  );
}
