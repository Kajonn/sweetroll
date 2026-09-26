import { useEffect, useState } from "react";

import { t } from "../i18n/index.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { EmptyState } from "../ui/EmptyState.js";
import { Panel } from "../ui/Panel.js";
import { Select } from "../ui/Select.js";
import styles from "./characters.module.css";

export type SlotGrantedActionInput = {
  id: string;
  label: string;
  valueType: "integer" | "decimal" | "boolean" | "text";
  required: boolean;
  default: unknown;
};

export type SlotGrantedAction = {
  id: string;
  label: string;
  actionKind: "roll" | "resourceBump";
  inputs: SlotGrantedActionInput[];
};

export type SlotTemplate = {
  id: string;
  label: string;
  kind: string;
  grantedActions: SlotGrantedAction[];
};

export type SlotListEntry = {
  entryId: string;
  templateId: string | null;
  label: string;
  values: Record<string, unknown>;
};

export type SlotListControlProps = {
  slotId: string;
  label: string;
  accepts: string[];
  entries: SlotListEntry[];
  templates: SlotTemplate[];
  disabled: boolean;
  /**
   * Granted-action buttons follow the entity-action availability (online,
   * owned, granted executor wired) rather than the edit gate, so offline
   * entry edits stay enabled while rolls stay disabled.
   */
  actionsDisabled?: boolean;
  onAddEntry(slotId: string, templateId: string | null, values: Record<string, unknown>): void | Promise<void>;
  onRemoveEntry(entryId: string): void | Promise<void>;
  onUpdateEntry(entryId: string, values: Record<string, unknown>): void | Promise<void>;
  onExecuteGranted(entryId: string, actionId: string, inputs: Record<string, unknown>): void | Promise<void>;
};

function describeCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return t("character.command.failed", { message });
}

function scalarSummary(values: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function invokeCommand(invoke: () => void | Promise<void>, onError: (message: string) => void): void {
  onError("");
  let result: void | Promise<void>;
  try {
    result = invoke();
  } catch (error) {
    onError(describeCommandError(error));
    return;
  }
  if (result !== undefined && result !== null && typeof (result as Promise<void>).then === "function") {
    (result as Promise<void>).then(undefined, (error: unknown) => onError(describeCommandError(error)));
  }
}

function GrantedActionForm({ entryId, action, disabled, onExecute }: {
  entryId: string;
  action: SlotGrantedAction;
  disabled: boolean;
  onExecute(entryId: string, actionId: string, inputs: Record<string, unknown>): void | Promise<void>;
}) {
  const [inputs, setInputs] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(action.inputs.map((input) => [input.id, input.default])));
  const [commandError, setCommandError] = useState("");
  return (
    <form
      className={styles.action}
      data-testid={`slot-granted-${entryId}-${action.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        invokeCommand(() => onExecute(entryId, action.id, inputs), (message) => setCommandError(message));
      }}
    >
      {action.inputs.map((input) => (
        <label key={input.id}>
          {input.label}
          <input
            type={input.valueType === "integer" || input.valueType === "decimal" ? "number" : input.valueType === "boolean" ? "checkbox" : "text"}
            required={input.required}
            value={input.valueType === "boolean" ? undefined : String(inputs[input.id] ?? "")}
            checked={input.valueType === "boolean" ? inputs[input.id] === true : undefined}
            onChange={(event) => setInputs((current) => ({
              ...current,
              [input.id]: input.valueType === "boolean"
                ? event.target.checked
                : input.valueType === "integer" || input.valueType === "decimal"
                  ? Number(event.target.value)
                  : event.target.value,
            }))}
            disabled={disabled}
          />
        </label>
      ))}
      <Button type="submit" variant="secondary" disabled={disabled}>{action.label}</Button>
      {commandError !== "" ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
    </form>
  );
}

function RemoveEntryButton({ entry, slotLabel, disabled, onRemove }: {
  entry: SlotListEntry;
  slotLabel: string;
  disabled: boolean;
  onRemove(entryId: string): void | Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [commandError, setCommandError] = useState("");
  return (
    <>
      <Button
        type="button"
        variant="danger"
        disabled={disabled}
        data-testid={`slot-entry-remove-${entry.entryId}`}
        onClick={() => {
          setCommandError("");
          setConfirmOpen(true);
        }}
      >
        {t("character.slot.remove", { label: entry.label })}
      </Button>
      {commandError !== "" ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("character.slot.removeTitle", { label: entry.label })}
        description={t("character.slot.removeDescription", { label: entry.label, slot: slotLabel })}
        closeLabel={t("character.slot.cancel")}
        actions={(
          <Button
            type="button"
            variant="danger"
            data-testid={`slot-entry-remove-confirm-${entry.entryId}`}
            onClick={() => invokeCommand(() => onRemove(entry.entryId), (message) => {
              if (message === "") {
                setConfirmOpen(false);
              } else {
                setCommandError(message);
              }
            })}
          >
            {t("character.slot.confirmRemove")}
          </Button>
        )}
      >
        <p className={styles.meta}>{entry.label}</p>
      </Dialog>
    </>
  );
}

function RenameEntryForm({ entry, disabled, onUpdate }: {
  entry: SlotListEntry;
  disabled: boolean;
  onUpdate(entryId: string, values: Record<string, unknown>): void | Promise<void>;
}) {
  const current = typeof entry.values.name === "string" ? entry.values.name : "";
  const [draft, setDraft] = useState(current);
  const [commandError, setCommandError] = useState("");
  useEffect(() => {
    setDraft(current);
  }, [current]);
  return (
    <form
      className={styles.field}
      data-testid={`slot-entry-rename-${entry.entryId}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || draft === current) return;
        invokeCommand(() => onUpdate(entry.entryId, { name: draft }), (message) => setCommandError(message));
      }}
    >
      <label>
        {t("character.slot.customName")}
        <input
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <Button type="submit" variant="secondary" disabled={disabled || draft === current}>{t("character.slot.saveName")}</Button>
      {commandError !== "" ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
    </form>
  );
}

function AddEntryDialog({ slotId, label, accepts, templates, disabled, onAdd }: {
  slotId: string;
  label: string;
  accepts: string[];
  templates: SlotTemplate[];
  disabled: boolean;
  onAdd(slotId: string, templateId: string | null, values: Record<string, unknown>): void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const offered = templates.filter((template) => accepts.includes(template.kind));
  const [selected, setSelected] = useState<string>(offered[0]?.id ?? "");
  const [customName, setCustomName] = useState("");
  const [commandError, setCommandError] = useState("");
  const isCustom = selected === "";
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        data-testid={`slot-add-${slotId}`}
        onClick={() => {
          setCommandError("");
          setSelected(offered[0]?.id ?? "");
          setCustomName("");
          setOpen(true);
        }}
      >
        {t("character.slot.add", { label })}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("character.slot.addTitle", { label })}
        description={t("character.slot.addDescription")}
        closeLabel={t("character.slot.cancel")}
        actions={(
          <Button
            type="button"
            variant="primary"
            disabled={disabled || (isCustom && customName.trim() === "")}
            data-testid={`slot-add-confirm-${slotId}`}
            onClick={() => invokeCommand(
              () => onAdd(slotId, isCustom ? null : selected, isCustom ? { name: customName.trim() } : {}),
              (message) => {
                if (message === "") {
                  setOpen(false);
                } else {
                  setCommandError(message);
                }
              },
            )}
          >
            {t("character.slot.confirmAdd")}
          </Button>
        )}
      >
        <Select
          label={t("character.slot.template")}
          data-testid={`slot-template-picker-${slotId}`}
          value={selected}
          disabled={disabled}
          onChange={(event) => setSelected(event.target.value)}
          options={[
            ...offered.map((template) => ({ value: template.id, label: template.label })),
            { value: "", label: t("character.slot.customEntry") },
          ]}
        />
        {isCustom ? (
          <label className={styles.field}>
            {t("character.slot.customName")}
            <input
              type="text"
              className={styles.dialogField}
              data-testid={`slot-custom-name-${slotId}`}
              value={customName}
              disabled={disabled}
              onChange={(event) => setCustomName(event.target.value)}
            />
          </label>
        ) : null}
        {commandError !== "" ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
      </Dialog>
    </>
  );
}

/**
 * Task 7 sheet control for one typed slot: entry list, template-picker add
 * flow with a labeled custom-entry fallback, destructive-confirm removal,
 * and inline template-granted action buttons. Synthetic granted-action
 * projection elements are owned here (CharacterSheet skips them), resolved
 * against the template catalog passed down from the route.
 */
export function SlotListControl({ slotId, label, accepts, entries, templates, disabled, actionsDisabled, onAddEntry, onRemoveEntry, onUpdateEntry, onExecuteGranted }: SlotListControlProps) {
  const byId = new Map(templates.map((template) => [template.id, template]));
  const grantedDisabled = actionsDisabled ?? disabled;
  return (
    <div data-testid={`slot-list-${slotId}`}>
      <Panel
        title={label}
        actions={(
          <AddEntryDialog
            slotId={slotId}
            label={label}
            accepts={accepts}
            templates={templates}
            disabled={disabled}
            onAdd={onAddEntry}
          />
        )}
      >
        {entries.length === 0 ? (
          <div data-testid={`slot-empty-${slotId}`}>
            <EmptyState title={t("character.slot.empty")} />
          </div>
        ) : (
          <ul className={styles.slotList}>
            {entries.map((entry) => {
              const template = entry.templateId === null ? undefined : byId.get(entry.templateId);
              const summary = scalarSummary(entry.values);
              return (
                <li key={entry.entryId} data-testid={`slot-entry-${entry.entryId}`} className={styles.slotEntry}>
                  <span className={styles.slotEntryLabel}>{entry.label}</span>
                  <span className={styles.meta}>{summary ?? t("character.slot.valuesEmpty")}</span>
                  {template?.grantedActions.map((action) => (
                    <GrantedActionForm
                      key={action.id}
                      entryId={entry.entryId}
                      action={action}
                      disabled={grantedDisabled}
                      onExecute={onExecuteGranted}
                    />
                  ))}
                  {entry.templateId === null ? (
                    <RenameEntryForm entry={entry} disabled={disabled} onUpdate={onUpdateEntry} />
                  ) : null}
                  <RemoveEntryButton entry={entry} slotLabel={label} disabled={disabled} onRemove={onRemoveEntry} />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
