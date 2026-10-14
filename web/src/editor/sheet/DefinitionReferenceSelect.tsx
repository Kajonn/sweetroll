import { useId } from "react";

/** Reference IDs are chosen by name; the document still stores the stable ID. */
export type ReferenceOption = {
  kind: "field" | "resource" | "action" | "slot";
  id: string;
  label: string;
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
          <option key={option.id} value={option.id}>{option.label} ({option.id})</option>
        ))}
      </select>
      {value && !found ? <p role="alert">Reference not found: {value}</p> : null}
    </div>
  );
}
