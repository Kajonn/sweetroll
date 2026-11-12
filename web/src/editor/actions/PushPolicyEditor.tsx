import { useEffect, useState } from "react";
import {
  parse,
  children,
  validatePushPolicies,
  type ExpressionAstV1,
  type PushPolicy,
} from "@sweetroll/rules";
import { Checkbox, NumberInput, FormField } from "../../ui/index.js";
function Faces({
  label,
  value,
  sides,
  disabled,
  onChange,
}: {
  label: string;
  value: number[];
  sides: number;
  disabled: boolean;
  onChange: (v: number[]) => void;
}) {
  const [raw, setRaw] = useState(value.join(", "));
  const [error, setError] = useState<string | null>(null);
  const supplied = value.join(", ");
  useEffect(() => {
    setRaw(supplied);
    setError(null);
  }, [supplied]);
  return (
    <FormField label={label}>
      <input
        type="text"
        value={raw}
        disabled={disabled}
        aria-label={label}
        aria-invalid={error !== null}
        onChange={(e) => {
          setRaw(e.target.value);
          const values = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number);
          if (
            values.some((v) => !Number.isInteger(v) || v < 1 || v > sides) ||
            new Set(values).size !== values.length
          ) {
            setError(
              `Use unique faces from 1 to ${sides}, separated by commas.`,
            );
            return;
          }
          setError(null);
          onChange(values);
        }}
      />
      {error ? <span role="alert">{error}</span> : null}
    </FormField>
  );
}
export function PushPolicyEditor({
  source,
  policy,
  onChange,
  disabled = false,
}: {
  source: string;
  policy: PushPolicy | undefined;
  onChange: (p: PushPolicy | undefined) => void;
  disabled?: boolean | undefined;
}) {
  const parsed = parse(source);
  const groups: { id: string; label: string; sides: number; dynamic: boolean; modifiers: NonNullable<PushPolicy["groups"][number]["modifiers"]> }[] = [];
  const walk = (n: ExpressionAstV1) => {
    if (n.kind === "pool" && n.group && n.source.kind === "dice") {
      const sides = n.source.sides;
      groups.push({ ...n.group, sides: sides.kind === "numberLiteral" ? sides.value : 1000,
        dynamic: sides.kind !== "numberLiteral", modifiers: n.modifiers.map((modifier) => modifier.kind) });
    }
    children(n).forEach(walk);
  };
  if (parsed.ok) walk(parsed.ast);
  const suggested: PushPolicy = {
    version: "1.0",
    maxAttempts: 1,
    successThreshold: 1,
    allowOnSuccess: false,
    groups: (groups.some((g) => g.modifiers.length === 0) ? groups.filter((g) => g.modifiers.length === 0) : groups).map((g) => ({
      groupId: g.id,
      lockedFaces: [],
      reportedFaces: [],
    })),
  };
  const candidate = policy ?? suggested;
  const errors = parsed.ok
    ? validatePushPolicies({
        templates: [],
        actions: [
          {
            kind: "roll",
            id: "editor",
            label: "",
            expressionId: "expr",
            outputTemplate: "",
            inputs: [],
            pushPolicy: policy ?? { ...candidate, groups: candidate.groups.map((group) => {
              const modifiers = groups.find((g) => g.id === group.groupId)?.modifiers;
              return modifiers?.length ? { ...group, modifiers } : group;
            }) },
          },
        ],
        expressions: [{ id: "expr", ast: parsed.ast }],
      })
    : [{ message: "Invalid expression." }];
  const supported = groups.length > 0 && errors.length === 0;
  if (!groups.length && !policy) return null;
  const update = (patch: Partial<PushPolicy>) =>
    onChange({ ...candidate, ...patch });
  return (
    <details>
      <summary>Push rules</summary>
      <Checkbox
        label="Enable pushing"
        checked={policy !== undefined}
        disabled={disabled || (!supported && !policy)}
        onChange={(e) => onChange(e.target.checked ? suggested : undefined)}
      />
      {!supported ? (
        <p role="status">
          Pushing needs a named dice group in an additive sum/count formula.{" "}
          {errors[0]?.message}
        </p>
      ) : null}
      {policy ? (
        <div>
          <p>
            Push the original saved pool. Unlisted groups and locked faces stay
            unchanged. Reported faces are for manual bookkeeping.
          </p>
          <NumberInput
            label="Maximum pushes"
            value={policy.maxAttempts}
            min={1}
            max={10}
            disabled={disabled}
            onChange={(v) => update({ maxAttempts: v ?? 1 })}
          />
          <NumberInput
            label="Success threshold for pushing"
            value={policy.successThreshold}
            min={-1e9}
            max={1e9}
            disabled={disabled}
            onChange={(v) => update({ successThreshold: v ?? 1 })}
          />
          <Checkbox
            label="Allow pushing a successful roll"
            checked={policy.allowOnSuccess}
            disabled={disabled}
            onChange={(e) => update({ allowOnSuccess: e.target.checked })}
          />
          {groups.map((g) => {
            const configured = policy.groups.find((p) => p.groupId === g.id);
            const change = (patch: Partial<PushPolicy["groups"][number]>) =>
              update({
                groups: policy.groups.map((p) =>
                  p.groupId === g.id ? { ...p, ...patch } : p,
                ),
              });
            return (
              <fieldset key={g.id}>
                <legend>
                  {g.label} ({g.dynamic ? "variable die" : `d${g.sides}`})
                </legend>
                <Checkbox
                  label={`Push ${g.label}`}
                  checked={configured !== undefined}
                  disabled={disabled}
                  onChange={(e) =>
                    update({
                      groups: e.target.checked
                        ? [
                            ...policy.groups,
                            {
                              groupId: g.id,
                              lockedFaces: [],
                              reportedFaces: [],
                            },
                          ]
                        : policy.groups.filter((p) => p.groupId !== g.id),
                    })
                  }
                />
                {configured ? (
                  <>
                    {g.modifiers.length > 0 ? <Checkbox
                      label={`Allow modified dice in ${g.label}`}
                      checked={g.modifiers.every((modifier) => configured.modifiers?.includes(modifier))}
                      disabled={disabled}
                      onChange={(e) => change({ modifiers: e.target.checked ? g.modifiers : [] })}
                    /> : null}
                    <Faces
                      label={`Locked faces for ${g.label}`}
                      value={configured.lockedFaces}
                      sides={g.sides}
                      disabled={disabled}
                      onChange={(v) => change({ lockedFaces: v })}
                    />
                    <Faces
                      label={`Reported faces for ${g.label}`}
                      value={configured.reportedFaces}
                      sides={g.sides}
                      disabled={disabled}
                      onChange={(v) => change({ reportedFaces: v })}
                    />
                  </>
                ) : null}
              </fieldset>
            );
          })}
        </div>
      ) : null}
    </details>
  );
}
