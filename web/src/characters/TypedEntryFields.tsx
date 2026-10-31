import { Select } from "../ui/Select.js";
import type { SlotTemplateField } from "./SlotListControl.js";
export function TypedEntryFields({
  fields,
  values,
  onChange,
  disabled,
  testIdPrefix = "typed-field",
}: {
  fields: SlotTemplateField[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  disabled: boolean;
  testIdPrefix?: string;
}) {
  const setValue = (id: string, value: unknown) =>
    onChange({ ...values, [id]: value });
  return (
    <>
      {fields.map((field) => {
        const value = Object.hasOwn(values, field.id)
          ? values[field.id]
          : field.default;
        if (field.kind === "boolean")
          return (
            <label key={field.id}>
              <input
                type="checkbox"
                checked={value === true}
                disabled={disabled}
                onChange={(event) => setValue(field.id, event.target.checked)}
              />{" "}
              {field.label}
            </label>
          );
        if (field.kind === "singleChoice")
          return (
            <Select
              key={field.id}
              label={field.label}
              value={typeof value === "string" ? value : ""}
              disabled={disabled}
              onChange={(event) =>
                setValue(field.id, event.target.value || null)
              }
              options={[
                { value: "", label: "—" },
                ...(field.options ?? []).map((o) => ({
                  value: o.id,
                  label: o.label,
                })),
              ]}
            />
          );
        if (field.kind === "multiChoice")
          return (
            <fieldset key={field.id}>
              <legend>{field.label}</legend>
              {(field.options ?? []).map((option) => (
                <label key={option.id}>
                  <input
                    type="checkbox"
                    checked={Array.isArray(value) && value.includes(option.id)}
                    disabled={disabled}
                    onChange={(event) => {
                      const selected = Array.isArray(value)
                        ? (value as string[])
                        : [];
                      setValue(
                        field.id,
                        event.target.checked
                          ? [...selected, option.id]
                          : selected.filter((id) => id !== option.id),
                      );
                    }}
                  />{" "}
                  {option.label}
                </label>
              ))}
            </fieldset>
          );
        if (field.kind === "resource")
          return (
            <fieldset key={field.id}>
              <legend>{field.label}</legend>
              {(["current", "max"] as const).map((part) => {
                const resource =
                  value && typeof value === "object"
                    ? (value as Record<string, unknown>)
                    : {};
                return (
                  <label key={part}>
                    {part}
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={field.step ?? 1}
                      value={
                        typeof resource[part] === "number"
                          ? (resource[part] as number)
                          : ""
                      }
                      disabled={disabled}
                      required
                      onChange={(event) =>
                        setValue(field.id, {
                          ...resource,
                          [part]:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        })
                      }
                    />
                  </label>
                );
              })}
            </fieldset>
          );
        return (
          <label key={field.id}>
            {field.label}
            <input
              type={
                field.kind === "integer" || field.kind === "decimal"
                  ? "number"
                  : "text"
              }
              min={field.min}
              max={field.max}
              step={
                field.kind === "integer"
                  ? (field.step ?? 1)
                  : (field.step ?? "any")
              }
              minLength={field.minLength}
              maxLength={field.maxLength}
              required={field.required}
              value={
                typeof value === "string" || typeof value === "number"
                  ? value
                  : ""
              }
              disabled={disabled}
              data-testid={`${testIdPrefix}-${field.id}`}
              onChange={(event) =>
                setValue(
                  field.id,
                  field.kind === "integer" || field.kind === "decimal"
                    ? event.target.value === ""
                      ? null
                      : Number(event.target.value)
                    : event.target.value,
                )
              }
            />
          </label>
        );
      })}
    </>
  );
}
