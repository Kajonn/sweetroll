import { t } from "../../i18n/index.js";

const forms = [
  "if(condition, value, otherwise)",
  'has(fields.skills, "climb")',
  "floor(value)",
  "ceil(value)",
  "abs(value)",
  "min(a, b)",
  "max(a, b)",
  "value % divisor",
  'lookup("table", key, "column")',
  'lookupBand("table", fields.level, "column")',
  'sum("slot", "field")',
  'count("slot")',
  'sumWhere("slot", "field", "flag")',
  'countWhere("slot", "flag")',
  'maxOf("slot", "field")',
];

export function ExpressionSuggestions({
  references = [],
  disabled,
  onInsert,
}: {
  references?: readonly string[];
  disabled?: boolean | undefined;
  onInsert: (token: string) => void;
}) {
  return (
    <details>
      <summary>{t("editor.expression.grammarHelp")}</summary>
      <p>{t("editor.expression.grammarCore")}</p>
      <label>
        {t("editor.expression.insert")}
        <select
          value=""
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value !== "") onInsert(event.target.value);
          }}
        >
          <option value="">{t("editor.expression.choose")}</option>
          {[...forms, ...references].map((option) => <option key={option}>{option}</option>)}
        </select>
      </label>
    </details>
  );
}
