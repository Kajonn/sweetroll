import { describe, expect, it, vi } from "vitest";

import { compileExpression } from "./compile.js";
import { evaluate } from "./evaluate.js";
import { renderExpression } from "./render.js";
import { parse } from "./parser.js";

const fields = { proficient: "boolean", class: "text", skills: "choiceSet", "hp.current": "number", "hp.max": "number" } as const;
const bindings = { fields: { proficient: true, class: null, skills: ["climb"], "hp.current": 4, "hp.max": 9 }, inputs: {} };

function compile(source: string, context: "roll" | "computed" = "computed") {
  return compileExpression(source, { context, resultType: "number", fallback: -100, env: { fields, inputs: {} } });
}

describe("grammar 1.0", () => {
  it.each([
    ['if(fields.proficient, 2, 0) + if(fields.class == "fighter", 3, 0)', 2],
    ['if(has(fields.skills, "climb"), fields.hp.max - fields.hp.current, 0)', 5],
    ['max(1, floor(2.9), ceil(2.1), abs(-5), 13 % 4) + min(3, 7, 4)', 8],
    ['if(fields.class != "fighter", 7, 0)', 7],
    ['if(true, 2, 1 % 0)', 2],
  ])("evaluates %s", (source, expected) => {
    const compiled = compile(source);
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    expect(evaluate({ id: "bonus", ...compiled.value }, bindings)).toMatchObject({ ok: true, result: expected, diagnostics: [] });
  });

  it("only rolls dice in the selected branch and records only evaluated graph operands", () => {
    const compiled = compile('if(fields.proficient, group("attack", "Attack", d20), 100d6)', "roll");
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    const rng = vi.fn(() => 0.5);
    const result = evaluate({ id: "attack", ...compiled.value }, bindings, rng);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, result: 10, roll: { breakdown: {
      terms: expect.arrayContaining([expect.objectContaining({ id: "root", operandIds: ["root.0", "root.1"] })]),
    } } });
  });

  it.each([
    'if(1, 2, 3)', 'if(true, 2, "wrong")', 'if(false, d20, 0)', 'max(1)',
    'max(1, 2, 3, 4, 5, 6, 7, 8, 9)', 'has(fields.class, "climb")',
    'if(fields.skills == fields.skills, 1, 0)', 'fields.proficient.max', 'inputs.hp.max',
  ])("rejects %s", (source) => {
    expect(compile(source).ok).toBe(false);
  });

  it("round trips escaped strings and resource references", () => {
    const source = 'if(fields.class == ' + JSON.stringify('quote " and newline\n') + ', fields.hp.max % 4, 0)';
    const parsed = parse(source);
    if (!parsed.ok) throw Error(JSON.stringify(parsed.diagnostics));
    expect(parse(renderExpression(parsed.ast))).toEqual(parsed);
  });
});

it("type-checks both branches and charges them to the static budget", () => {
  let balanced = "1";
  for (let depth = 0; depth < 7; depth++) balanced = `(${balanced}+${balanced})`;
  expect(compile(`if(true,1,${balanced})`)).toMatchObject({
    ok: false, diagnostics: [{ code: "limit_exceeded" }],
  });
  expect(compile('if(true, 1, fields.unknown)')).toMatchObject({
    ok: false, diagnostics: [{ code: "missing_reference" }],
  });
});

it("uses a diagnostic fallback for a zero divisor", () => {
  const compiled = compile("9 % 0");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  expect(evaluate({ id: "remainder", ...compiled.value }, bindings)).toMatchObject({
    ok: true, result: -100, diagnostics: [{ code: "arithmetic_failure" }],
  });
});

it("keeps well-typed conditional results scalar over varied branches and choices", () => {
  const source = 'if(fields.proficient && has(fields.skills, "climb"), max(0, fields.hp.max - fields.hp.current, 1), abs(fields.hp.current % 3))';
  const compiled = compile(source);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  for (let max = 1; max <= 20; max++) {
    for (let current = 0; current <= max; current++) {
      const proficient = max % 2 === 0;
      const skills = current % 2 === 0 ? ["climb"] : [];
      const result = evaluate({ id: "conditional", ...compiled.value }, {
        fields: { proficient, skills, "hp.current": current, "hp.max": max }, inputs: {},
      });
      expect(result).toMatchObject({
        ok: true,
        result: proficient && skills.length > 0 ? Math.max(max - current, 1) : current % 3,
        diagnostics: [],
      });
    }
  }
});
