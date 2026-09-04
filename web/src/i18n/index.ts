import { defaultMessages, type MessageTable } from "./messages.js";

let current: MessageTable = { ...defaultMessages };

export function registerLocale(table: MessageTable): void {
  current = { ...current, ...table };
}

export function resetLocale(): void {
  current = { ...defaultMessages };
}

export function t(id: string, params?: Record<string, string | number>): string {
  const msg = current[id];
  if (msg === undefined) {
    if (import.meta.env?.MODE !== "production") console.warn(`[i18n] missing key: ${id}`);
    return id;
  }
  if (params === undefined) return msg;
  return msg.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
}

export function listKeys(): string[] {
  return Object.keys(current);
}