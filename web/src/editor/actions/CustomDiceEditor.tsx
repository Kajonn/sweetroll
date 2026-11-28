import { useState } from "react";
import { PACKAGE_LIMITS, type CustomDie } from "@sweetroll/rules";

import { t } from "../../i18n/index.js";
import { Button, FormField } from "../../ui/index.js";
import { Disclosure } from "../../ui/Disclosure.js";
import { nextScopedId } from "../sheet/slotTypes.js";
import styles from "../DocumentEditor.module.css";

type Face = CustomDie["faces"][number];

export function CustomDiceEditor({ dice, usedIds, onChange }: {
  dice: CustomDie[];
  usedIds: Set<string>;
  onChange: (dice: CustomDie[]) => void;
}) {
  function addDie() {
    const id = nextScopedId(new Set(usedIds), "custom_die");
    onChange([...dice, { id, label: t("editor.customDice.new"), faces: [{ value: 0 }] }]);
  }
  return (
    <Disclosure label={t("editor.customDice.title")}>
      <Button variant="secondary" onClick={addDie} disabled={dice.length >= PACKAGE_LIMITS.customDice}>
        {t("editor.customDice.add")}
      </Button>
      {dice.map((die, index) => (
        <DieEditor key={die.id} die={die} index={index}
          onChange={(next) => onChange(dice.map(candidate => candidate.id === die.id ? next : candidate))}
          onRemove={() => onChange(dice.filter(candidate => candidate.id !== die.id))} />
      ))}
    </Disclosure>
  );
}

function DieEditor({ die, index, onChange, onRemove }: {
  die: CustomDie;
  index: number;
  onChange: (die: CustomDie) => void;
  onRemove: () => void;
}) {
  function changeFaces(faces: Face[]) {
    onChange({ ...die, faces });
  }
  return (
    <fieldset data-path={`/dice/${index}`}>
      <legend>{die.label}</legend>
      <FormField label={t("editor.customDice.label")}>
        <input value={die.label} maxLength={120} required
          onChange={(event) => onChange({ ...die, label: event.target.value })} />
      </FormField>
      <p><code>{`dice(1, ${JSON.stringify(die.id)})`}</code></p>
      {die.faces.map((face, faceIndex) => (
        <fieldset key={faceIndex} className={styles.customDieFace}>
          <legend>{t("editor.customDice.face", { number: String(faceIndex + 1) })}</legend>
          <FaceEditor face={face} canRemove={die.faces.length > 1}
            onChange={(next) => changeFaces(die.faces.map((entry, i) => i === faceIndex ? next : entry))}
            onRemove={() => changeFaces(die.faces.filter((_, i) => i !== faceIndex))} />
        </fieldset>
      ))}
      <Button variant="secondary" disabled={die.faces.length >= PACKAGE_LIMITS.facesPerCustomDie}
        onClick={() => changeFaces([...die.faces, { value: 0 }])}>
        {t("editor.customDice.addFace")}
      </Button>{" "}
      <Button variant="secondary" onClick={onRemove}>{t("editor.customDice.remove")}</Button>
    </fieldset>
  );
}

function FaceEditor({ face, canRemove, onChange, onRemove }: {
  face: Face;
  canRemove: boolean;
  onChange: (face: Face) => void;
  onRemove: () => void;
}) {
  const { label, ...withoutLabel } = face;
  const { symbols, ...withoutSymbols } = face;
  return (
    <>
      <FormField label={t("editor.customDice.faceValue")}>
        <input key={face.value} type="number" step="any" defaultValue={face.value}
          onBlur={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isFinite(value)) onChange({ ...face, value });
            else event.currentTarget.value = String(face.value);
          }} />
      </FormField>
      <FormField label={t("editor.customDice.faceLabel")} optional>
        <input value={label ?? ""} maxLength={120}
          onChange={(event) => onChange(event.target.value ? { ...face, label: event.target.value } : withoutLabel)} />
      </FormField>
      <SymbolsField key={JSON.stringify(symbols)} symbols={symbols}
        onChange={(next) => onChange(next === undefined ? withoutSymbols : { ...face, symbols: next })} />
      <Button variant="secondary" disabled={!canRemove} onClick={onRemove}>{t("editor.customDice.removeFace")}</Button>
    </>
  );
}

function SymbolsField({ symbols, onChange }: {
  symbols: Face["symbols"];
  onChange: (symbols: Face["symbols"]) => void;
}) {
  const [error, setError] = useState(false);
  const initial = Object.entries(symbols ?? {}).map(([id, count]) => `${id}=${count}`).join(", ");
  function save(raw: string) {
    if (raw === initial) return;
    const entries = raw.trim() === "" ? [] : raw.split(",");
    const next: Record<string, number> = {};
    for (const entry of entries) {
      const match = /^([a-z][a-z0-9_]{0,63})\s*=\s*(\d+)$/.exec(entry.trim());
      const id = match?.[1];
      const count = Number(match?.[2]);
      if (id === undefined || Object.hasOwn(next, id) || count < 1 || count > PACKAGE_LIMITS.symbolCountPerFace) {
        setError(true);
        return;
      }
      next[id] = count;
    }
    if (entries.length > PACKAGE_LIMITS.symbolsPerFace) {
      setError(true);
      return;
    }
    setError(false);
    onChange(entries.length === 0 ? undefined : next);
  }
  return (
    <FormField label={t("editor.customDice.symbols")} optional
      hint={t("editor.customDice.symbolsHint")}
      error={error ? t("editor.customDice.symbolsError") : undefined}>
      <input defaultValue={initial} onBlur={(event) => save(event.target.value)}
        onChange={() => setError(false)} />
    </FormField>
  );
}
