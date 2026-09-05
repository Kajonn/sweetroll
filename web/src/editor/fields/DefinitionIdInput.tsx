import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";

import { t } from "../../i18n/index.js";
import styles from "./DefinitionIdInput.module.css";

export const DEFINITION_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function isValidDefinitionId(value: string): boolean {
  return DEFINITION_ID_PATTERN.test(value);
}

export type DefinitionIdInputProps = {
  value: string;
  onChange: (next: string) => void;
  referencedBy?: number | undefined;
  disabled?: boolean | undefined;
};

export function DefinitionIdInput({
  value,
  onChange,
  referencedBy,
  disabled,
}: DefinitionIdInputProps) {
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState<string | null>(null);
  const refs = referencedBy ?? 0;

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const handleChange = (next: string) => {
    setDraft(next);
    if (next === value) {
      setPending(null);
    } else if (isValidDefinitionId(next) && refs > 0) {
      setPending(next);
    } else if (refs === 0) {
      onChange(next);
      setPending(null);
    } else {
      setPending(null);
    }
  };

  const confirm = () => {
    if (pending === null) return;
    const next = pending;
    setPending(null);
    onChange(next);
  };

  const cancel = () => {
    setDraft(value);
    setPending(null);
  };

  const valid = isValidDefinitionId(draft);
  const inputId = "definition-id-input";

  return (
    <div className={styles.field} data-testid="definition-id-input-wrapper">
      <label className={styles.label} htmlFor={inputId}>
        {t("editor.fields.id")}
      </label>
      <input
        id={inputId}
        className={styles.input}
        type="text"
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        pattern={DEFINITION_ID_PATTERN.source}
        maxLength={64}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={!valid}
        aria-describedby={refs > 0 ? "definition-id-references" : undefined}
        disabled={disabled}
        data-testid={inputId}
      />
      {!valid && (
        <p className={styles.error} data-testid="definition-id-input-error">
          {t("editor.fields.id.error")}
        </p>
      )}
      {refs > 0 && (
        <p className={styles.references} data-testid="definition-id-references">
          {t("editor.fields.id.referencedBy", { count: refs })}
        </p>
      )}
      <Dialog.Root
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.dialogOverlay} />
          <Dialog.Content
            className={styles.dialogContent}
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => e.preventDefault()}
            data-testid="definition-id-rename-confirm"
          >
            <Dialog.Title className={styles.dialogTitle}>
              {t("editor.fields.id.renameConfirm.title")}
            </Dialog.Title>
            <p className={styles.dialogBody}>
              {t("editor.fields.id.renameConfirm.message", { count: refs })}
            </p>
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.dialogCancel}
                onClick={cancel}
                data-testid="definition-id-rename-confirm-cancel"
              >
                {t("editor.fields.id.renameConfirm.cancel")}
              </button>
              <button
                type="button"
                className={styles.dialogConfirm}
                onClick={confirm}
                data-testid="definition-id-rename-confirm-submit"
              >
                {t("editor.fields.id.renameConfirm.confirm")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
