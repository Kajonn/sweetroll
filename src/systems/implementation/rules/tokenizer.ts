import type { RulesDiagnostic } from "./diagnostic.js";

export type Token =
  | { kind: "number"; value: number; start: number }
  | { kind: "boolean"; value: boolean; start: number }
  | { kind: "id"; scope: "fields" | "inputs"; id: string; start: number }
  | { kind: "function"; name: "min" | "max" | "round" | "dice" | "countSuccesses"; start: number }
  | { kind: "advDis"; which: "adv" | "dis"; start: number }
  | { kind: "dice"; count: number; sides: number; keep?: { mode: "highest" | "lowest"; count: number }; start: number }
  | { kind: "operator"; op: "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||" | "!"; start: number }
  | { kind: "lparen"; start: number }
  | { kind: "rparen"; start: number }
  | { kind: "comma"; start: number }
  | { kind: "roundMode"; mode: "nearest" | "down" | "up"; start: number };

export type TokenizeResult =
  | { ok: true; tokens: Token[] }
  | { ok: false; diagnostics: RulesDiagnostic[] };

const FUNCTIONS = new Set(["min", "max", "round", "dice", "countSuccesses"]);
const ASSIGNED_FUNCTIONS = new Set(["adv", "dis"]);
const ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SCOPE_RE = /^(fields|inputs)$/;

function error(message: string): RulesDiagnostic {
  return { code: "invalid_syntax", path: "", message };
}

export function tokenize(source: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  const fail = (msg: string): TokenizeResult => ({ ok: false, diagnostics: [error(msg)] });

  while (i < n) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    const start = i;

    const diceMatch = matchStaticDice(source, i);
    if (diceMatch) {
      if ("keep" in diceMatch) {
        tokens.push({ kind: "dice", count: diceMatch.count, sides: diceMatch.sides, keep: diceMatch.keep, start });
      } else {
        tokens.push({ kind: "dice", count: diceMatch.count, sides: diceMatch.sides, start });
      }
      i = diceMatch.end;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9]/.test(source[j]!)) j++;
      let val: number;
      if (j < n && source[j] === ".") {
        j++;
        const fracStart = j;
        while (j < n && /[0-9]/.test(source[j]!)) j++;
        if (j === fracStart) return fail("trailing decimal point");
        val = Number(source.slice(i, j));
      } else {
        val = Number(source.slice(i, j));
      }
      if (!Number.isFinite(val)) return fail("invalid number");
      tokens.push({ kind: "number", value: val, start });
      i = j;
      continue;
    }

    if (/[a-z]/i.test(ch)) {
      let j = i;
      while (j < n && /[a-z0-9_]/i.test(source[j]!)) j++;
      const word = source.slice(i, j);

      if (SCOPE_RE.test(word) && j < n && source[j] === ".") {
        let k = j + 1;
        if (k < n && /[a-z_]/.test(source[k]!)) {
          k++;
          while (k < n && /[a-z0-9_]/.test(source[k]!)) k++;
          const idPart = source.slice(j + 1, k);
          if (ID_RE.test(idPart)) {
            tokens.push({ kind: "id", scope: word as "fields" | "inputs", id: idPart, start });
            i = k;
            continue;
          }
        }
        return fail(`invalid identifier after '${word}.'`);
      }

      if (FUNCTIONS.has(word)) { tokens.push({ kind: "function", name: word as "min" | "max" | "round" | "dice" | "countSuccesses", start }); i = j; continue; }
      if (word === "true" || word === "false") { tokens.push({ kind: "boolean", value: word === "true", start }); i = j; continue; }
      if (ASSIGNED_FUNCTIONS.has(word)) { tokens.push({ kind: "advDis", which: word as "adv" | "dis", start }); i = j; continue; }
      if (word === "nearest" || word === "down" || word === "up") { tokens.push({ kind: "roundMode", mode: word as "nearest" | "down" | "up", start }); i = j; continue; }
      return fail(`unknown identifier '${word}'`);
    }

    const two = source.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) {
      tokens.push({ kind: "operator", op: two as "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||", start }); i += 2; continue;
    }
    if ("+-*/<>=!".includes(ch)) {
      tokens.push({ kind: "operator", op: ch as "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||" | "!", start }); i++; continue;
    }
    if (ch === "(") { tokens.push({ kind: "lparen", start }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen", start }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "comma", start }); i++; continue; }

    return fail(`unexpected character '${ch}'`);
  }
  return { ok: true, tokens };
}

type StaticDice = { count: number; sides: number; end: number } | { count: number; sides: number; keep: { mode: "highest" | "lowest"; count: number }; end: number };

function matchStaticDice(source: string, i: number): StaticDice | null {
  const n = source.length;
  let j = i;
  let count: number | undefined;
  if (/[0-9]/.test(source[j]!)) { let k = j; while (k < n && /[0-9]/.test(source[k]!)) k++; count = Number(source.slice(j, k)); j = k; }
  if (j >= n || source[j] !== "d") return null;
  if (j > i && /[a-z]/i.test(source[i]!)) return null;
  j++;
  if (j >= n || !/[0-9]/.test(source[j]!)) return null;
  let k = j; while (k < n && /[0-9]/.test(source[k]!)) k++;
  const sides = Number(source.slice(j, k));
  if (!Number.isInteger(sides) || sides < 1) return null;
  j = k;
  let keep: { mode: "highest" | "lowest"; count: number } | undefined;
  const kh = source.slice(j, j + 2);
  const kl = source.slice(j, j + 2);
  if (kh === "kh" || kl === "kl") {
    const mode = kh === "kh" ? "highest" : "lowest";
    j += 2;
    let kk = j; while (kk < n && /[0-9]/.test(source[kk]!)) kk++;
    if (kk === j) return null;
    const keepCount = Number(source.slice(j, kk));
    if (!Number.isInteger(keepCount) || keepCount < 1) return null;
    keep = { mode, count: keepCount };
    j = kk;
  }
  const resolvedCount = count ?? 1;
  if (!Number.isInteger(resolvedCount) || resolvedCount < 1) return null;
  if (keep !== undefined) return { count: resolvedCount, sides, keep, end: j };
  return { count: resolvedCount, sides, end: j };
}
