import { Check } from "lucide-react";
import { useState } from "react";

import type { ApiClient } from "../api/client.js";
import { useOpenSystem } from "../api/openSystem.js";
import { t } from "../i18n/index.js";
import styles from "./DocumentEditor.module.css";

type TabId = "metadata" | "entities" | "sheets" | "actions" | "validations" | "referenceData";

const TABS: ReadonlyArray<TabId> = [
  "metadata",
  "entities",
  "sheets",
  "actions",
  "validations",
  "referenceData",
];

function isTabId(value: string): value is TabId {
  return (TABS as ReadonlyArray<string>).includes(value);
}

function readActiveTab(): TabId {
  if (typeof window === "undefined") return "metadata";
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  if (tab !== null && isTabId(tab)) return tab;
  return "metadata";
}

export function DocumentEditor({ client, systemId }: { client: ApiClient; systemId: string }) {
  const query = useOpenSystem(client, systemId);
  const [active] = useState<TabId>(() => readActiveTab());

  if (query.isPending) {
    return (
      <section className={styles.container} data-testid="document-editor-loading">
        <p role="status" className={styles.placeholder}>
          {t("editor.loading")}
        </p>
      </section>
    );
  }
  if (query.isError) {
    return (
      <section className={styles.container} data-testid="document-editor-error">
        <p role="alert" className={styles.placeholder}>
          {t("editor.error")}
        </p>
      </section>
    );
  }
  if (query.data === undefined) return null;

  const ws = query.data;
  return (
    <section className={styles.container}>
      <header className={styles.header} data-testid="document-editor-header">
        <h1
          className={styles.name}
          contentEditable
          suppressContentEditableWarning
          aria-label={t("editor.systemNameAria")}
          data-testid="document-editor-name"
        >
          {ws.system.name}
        </h1>
        <span className={styles.lifecycle} data-testid="document-editor-lifecycle">
          {t(`editor.lifecycle.${ws.system.lifecycle}`)}
        </span>
        <span className={styles.autosave} data-testid="document-editor-autosave">
          <Check aria-hidden size={14} />
          {t("editor.autosave.idle")}
        </span>
      </header>
      <nav className={styles.tabs} aria-label={t("editor.tabsAriaLabel")}>
        {TABS.map((tab) => {
          const isActive = tab === active;
          return (
            <a
              key={tab}
              href={`?tab=${tab}`}
              aria-current={isActive ? "page" : undefined}
              className={isActive ? styles.tabActive : styles.tab}
              data-testid={`document-editor-tab-${tab}`}
            >
              {t(`editor.tab.${tab}`)}
            </a>
          );
        })}
      </nav>
      <main className={styles.body} data-testid={`document-editor-body-${active}`}>
        <p className={styles.placeholder}>{t("editor.bodyPlaceholder")}</p>
      </main>
    </section>
  );
}
