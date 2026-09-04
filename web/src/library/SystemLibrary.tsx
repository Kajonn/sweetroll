import { useEffect, useRef, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { useSystemLibrary } from "../api/listSystems.js";
import { t } from "../i18n/index.js";

import { CreateDraftDialog } from "./CreateDraftDialog.js";
import styles from "./SystemLibrary.module.css";

export function SystemLibrary({ client }: { client: ApiClient }) {
  const { data, fetchNextPage, hasNextPage } = useSystemLibrary(client);
  const [createOpen, setCreateOpen] = useState(false);
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "j" || e.key === "ArrowDown") moveActive(el, 1);
      if (e.key === "k" || e.key === "ArrowUp") moveActive(el, -1);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          data-testid="library-new-system"
        >
          {t("library.createDraft")}
        </button>
      </div>
      <ul ref={ref} className={styles.list} aria-label={t("library.listAriaLabel")} data-testid="system-library">
        {data?.pages.flatMap((p) => p.systems).map((s, i) => (
          <li key={s.systemId} data-testid={`system-row-${i}`} tabIndex={-1}>
            <a href={`/systems/${s.systemId}`}>{s.name}</a>
            <span>{s.lifecycle}</span>
          </li>
        ))}
        {hasNextPage === true && <li><button type="button" onClick={() => fetchNextPage()}>{t("library.loadMore")}</button></li>}
      </ul>
      <CreateDraftDialog client={client} open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function moveActive(el: HTMLUListElement, delta: number) {
  const items = Array.from(el.querySelectorAll<HTMLLIElement>('[data-testid^="system-row-"]'));
  const active = items.findIndex((i) => i.getAttribute("data-active") === "true");
  const next = Math.max(0, Math.min(items.length - 1, active + delta));
  items.forEach((i, idx) => (idx === next ? i.setAttribute("data-active", "true") : i.removeAttribute("data-active")));
  items[next]?.focus();
}