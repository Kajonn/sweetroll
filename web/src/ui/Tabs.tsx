import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import styles from "./Tabs.module.css";

export type TabItem = {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
};

export type TabsProps = {
  tabs: ReadonlyArray<TabItem>;
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  ariaLabel: string;
};

/**
 * WAI-APG automatic-activation tablist built on native buttons.
 * Arrow keys move and select; Home/End jump; tabs are Tab-reachable.
 */
export function Tabs({ tabs, value, defaultValue, onChange, ariaLabel }: TabsProps) {
  const generated = useId();
  const base = `ui-tabs-${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const firstEnabled = tabs.find((tab) => !tab.disabled)?.id ?? tabs[0]?.id;
  const [internal, setInternal] = useState<string | undefined>(defaultValue ?? firstEnabled);
  const selected = value ?? internal;

  const select = (id: string) => {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab || tab.disabled) return;
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };

  const focusTab = (index: number) => {
    tabRefs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const enabledIndexes = tabs
      .map((tab, tabIndex) => ({ tab, tabIndex }))
      .filter(({ tab }) => !tab.disabled)
      .map(({ tabIndex }) => tabIndex);
    if (enabledIndexes.length === 0) return;
    const current = enabledIndexes.indexOf(index);
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = enabledIndexes[(current + 1) % enabledIndexes.length];
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = enabledIndexes[(current - 1 + enabledIndexes.length) % enabledIndexes.length];
    } else if (event.key === "Home") {
      next = enabledIndexes[0];
    } else if (event.key === "End") {
      next = enabledIndexes[enabledIndexes.length - 1];
    }
    const nextTab = next === undefined ? undefined : tabs[next];
    if (next !== undefined && nextTab !== undefined) {
      event.preventDefault();
      select(nextTab.id);
      focusTab(next);
    }
  };

  const active = tabs.find((tab) => tab.id === selected && !tab.disabled) ?? tabs.find((tab) => !tab.disabled);

  return (
    <div className={styles.tabs}>
      <div role="tablist" aria-label={ariaLabel} className={styles.tabList}>
        {tabs.map((tab, index) => {
          const isSelected = active?.id === tab.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => select(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={styles.tab}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {active ? (
        <div
          role="tabpanel"
          id={`${base}-panel-${active.id}`}
          aria-labelledby={`${base}-tab-${active.id}`}
          tabIndex={0}
          className={styles.panel}
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}
