import { useEffect } from "react";

const isTextInput = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
};

export function parseCombo(combo: string): { key: string; alt: boolean; shift: boolean; ctrl: boolean } {
  const parts = combo.split("+");
  return {
    key: (parts.at(-1) ?? "").toLowerCase(),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
    ctrl: parts.includes("Ctrl") || parts.includes("Meta"),
  };
}

export function useShortcut(combo: string, handler: () => void): void {
  useEffect(() => {
    const target = parseCombo(combo);
    const onKey = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;
      if (e.key.toLowerCase() !== target.key) return;
      if (e.altKey !== target.alt) return;
      if (e.shiftKey !== target.shift) return;
      if (e.ctrlKey !== target.ctrl) return;
      e.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [combo, handler]);
}