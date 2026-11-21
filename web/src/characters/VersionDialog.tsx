import { useEffect, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import { Button } from "../ui/Button.js";
import type { CharactersApi } from "./api.js";
import { focusFirst, trapTabKey } from "./dialogTrap.js";
import type { CharacterSession } from "./session.js";
import type { VersionCheckResponse, VersionOptionsResponse } from "./types.js";
import { VersionReportSummary } from "./VersionReport.js";
import { compositionChoices, compositionLabel, type CompositionChoice } from "./compositionChoices.js";
import styles from "./characters.module.css";

type Props = {
  characterId: string;
  api: Required<Pick<CharactersApi, "versionOptions" | "versionCheck">>;
  session: CharacterSession;
  /** Mirrors the other management tools: pending edits, offline, read-only. */
  blocked: boolean;
  onClose(): void;
};

/**
 * Design 6.7/6.8 "Rules and extensions" dialog: list the revert target, later
 * base versions and the extension changes (upgrade, add, remove), run the
 * server dry run for one choice, and only then offer the change. The change
 * goes through the session (online only).
 */
export function VersionDialog({ characterId, api, session, blocked, onClose }: Props) {
  const [options, setOptions] = useState<VersionOptionsResponse["options"] | null>(null);
  const [target, setTarget] = useState<CompositionChoice | null>(null);
  const [check, setCheck] = useState<VersionCheckResponse["check"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    let active = true;
    focusFirst(dialogRef.current);
    api.versionOptions(characterId).then(
      (response) => { if (active) { setOptions(response.options); setBusy(false); } },
      (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error && err.message ? err.message : t("version.loadFailed"));
        setBusy(false);
      },
    );
    return () => { active = false; };
  }, [api, characterId]);

  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  const choose = async (choice: CompositionChoice) => {
    setTarget(choice);
    setCheck(null);
    setError(null);
    setBusy(true);
    try {
      setCheck((await api.versionCheck(characterId, choice.target)).check);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("version.checkFailed"));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (target === null || check === null || !check.report.ok) return;
    setBusy(true);
    setError(null);
    try {
      await session.changeVersion(target.target);
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("version.changeFailed"));
      setBusy(false);
    }
  };

  const choices = options === null ? [] : compositionChoices(options);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("version.title")}
      className={styles.dialog}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        trapTabKey(event, dialogRef.current);
      }}
    >
      <h2>{t("version.title")}</h2>
      {error !== null ? <p ref={errorRef} tabIndex={-1} role="alert">{error}</p> : null}
      {options === null ? null : (
        <>
          <p>{t("version.current", { version: compositionLabel(options.current) })}</p>
          {choices.length === 0 ? <p>{t("version.none")}</p> : (
            <fieldset>
              <legend>{t("version.choose")}</legend>
              {choices.map((choice) => (
                <label key={choice.key} className={styles.versionChoice}>
                  <input
                    type="radio"
                    name="target-version"
                    value={choice.key}
                    checked={target?.key === choice.key}
                    disabled={busy}
                    onChange={() => void choose(choice)}
                  />
                  {choice.label}
                  {choice.notes.length > 0 ? <span className={styles.versionNotes}>{choice.notes}</span> : null}
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      {check === null ? null : <VersionReportSummary report={check.report} />}
      {blocked ? <p>{t("version.blockedPending")}</p> : null}
      <div className={styles.dialogActions}>
        <Button
          type="button"
          variant="primary"
          disabled={busy || blocked || check === null || !check.report.ok}
          onClick={() => void confirm()}
        >
          {t(check?.direction === "revert" ? "version.confirmRevert" : "version.confirmUpgrade")}
        </Button>
        <Button type="button" variant="secondary" disabled={busy && check !== null} onClick={onClose}>
          {t("character.tools.close")}
        </Button>
      </div>
    </div>
  );
}
