export type Token =
  | { kind: "number"; value: number; start: number }
  | { kind: "boolean"; value: boolean; start: number }
  | { kind: "id"; scope: "fields" | "inputs"; id: string; start: number }
  | { kind: "operator"; op: "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||" | "!"; start: number }
  | { kind: "lparen"; start: number }
  | { kind: "rparen"; start: number };

export type ExpressionDiagnostic = { code: string; path: string; message: string };

export type TokenizeResult =
  | { ok: true; tokens: Token[] }
  | { ok: false; diagnostics: ExpressionDiagnostic[] };

const ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SCOPE_RE = /^(fields|inputs)$/;

function error(message: string): ExpressionDiagnostic {
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

      if (word === "true" || word === "false") {
        tokens.push({ kind: "boolean", value: word === "true", start });
        i = j;
        continue;
      }
      return fail(`unknown identifier '${word}'`);
    }

    const two = source.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) {
      tokens.push({ kind: "operator", op: two as "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||", start });
      i += 2;
      continue;
    }
    if ("+-*/<>=!".includes(ch)) {
      tokens.push({ kind: "operator", op: ch as "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||" | "!", start });
      i++;
      continue;
    }
    if (ch === "(") { tokens.push({ kind: "lparen", start }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen", start }); i++; continue; }

    return fail(`unexpected character '${ch}'`);
  }
  return { ok: true, tokens };
}
