import { useDebugMode } from "../../ui/debugMode.js";
import { useId } from "react";

/** Reference IDs are chosen by name; the document still stores the stable ID. */
export type ReferenceOption = {
  kind: "field" | "resource" | "action" | "slot";
  id: string;
  label: string;
  ownerId?: string;
};

export function DefinitionReferenceSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: ReadonlyArray<ReferenceOption>;
  onChange: (next: string) => void;
  label: string;
}) {
  const debug = useDebugMode();
  const inputId = useId();
  const found = options.some((option) => option.id === value);
  return (
    <div>
      <label htmlFor={inputId}>{label}</label>
      <select
        id={inputId}
        data-testid="definition-reference-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" disabled>Select a definition</option>
        {value && !found ? (
          <option value={value} disabled>Missing definition ({value})</option>
        ) : null}
        {options.map((option) => (
          <option key={option.id} value={option.id}>{option.label}{option.ownerId ? ` (${option.ownerId}.${option.id})` : debug || options.filter(candidate => candidate.label === option.label).length > 1 ? ` (${option.id})` : ""}</option>
        ))}
      </select>
      {value && !found ? <p role="alert">Reference not found: {value}</p> : null}
    </div>
  );
}
