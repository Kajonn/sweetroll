import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, type ApiClient } from "../api/client.js";
import { useSaveDraft } from "../api/saveDraft.js";

export type SyncStatus = "idle" | "saving" | "saved" | "conflict" | "error";

export type ConflictBanner = {
  latestRevision: number;
  onAcceptTheirs: () => void;
  onKeepMine: () => void;
  onMergeIntoServer: () => void;
  onDismiss: () => void;
};

export type DraftSync = {
  save: (document: unknown, expectedRevision: number | null) => void;
  status: SyncStatus;
  banner: ConflictBanner | null;
  error: Error | null;
};

export type UseDraftSyncInput = {
  client: ApiClient;
  systemId: string;
  debounceMs?: number;
  onAcceptTheirs?: () => void;
  onSaved?: () => void;
};

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashCache = new WeakMap<object, string>();

function hashDocument(document: unknown): string {
  if (document === null || document === undefined) return stableStringify(document);
  if (typeof document !== "object") return stableStringify(document);
  const cached = hashCache.get(document as object);
  if (cached !== undefined) return cached;
  const out = stableStringify(document);
  hashCache.set(document as object, out);
  return out;
}

type PendingSave = { document: unknown; expectedRevision: number | null; hash: string };

export function useDraftSync(input: UseDraftSyncInput): DraftSync {
  const debounceMs = input.debounceMs ?? 600;
  const mutation = useSaveDraft(input.client);

  const [status, setStatus] = useState<SyncStatus>("idle");
  const [banner, setBanner] = useState<ConflictBanner | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const lastSavedHashRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingSave | null>(null);
  const latestDocumentRef = useRef<unknown>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onAcceptTheirsRef = useRef(input.onAcceptTheirs);
  onAcceptTheirsRef.current = input.onAcceptTheirs;
  const onSavedRef = useRef(input.onSaved);
  onSavedRef.current = input.onSaved;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const fireSave = useCallback(
    (document: unknown, expectedRevision: number | null, hash: string) => {
      lastSavedHashRef.current = null;
      pendingRef.current = { document, expectedRevision, hash };
      setStatus("saving");
      setError(null);
      mutation.mutate(
        { systemId: input.systemId, expectedRevision, document },
        {
          onSuccess: () => {
            if (!mountedRef.current) return;
            lastSavedHashRef.current = hash;
            setStatus("saved");
            setBanner(null);
            onSavedRef.current?.();
          },
          onError: (err) => {
            if (!mountedRef.current) return;
            if (err instanceof ApiError && err.status === 409 && err.latestRevision !== null) {
              const latestRevision = err.latestRevision;
              setStatus("conflict");
              setError(null);
              setBanner({
                latestRevision,
                onAcceptTheirs: () => {
                  if (!mountedRef.current) return;
                  setBanner(null);
                  setStatus("idle");
                  onAcceptTheirsRef.current?.();
                },
                onKeepMine: () => {
                  if (!mountedRef.current) return;
                  setBanner(null);
                  fireSave(latestDocumentRef.current, null, hashDocument(latestDocumentRef.current));
                },
                onMergeIntoServer: () => {
                  if (!mountedRef.current) return;
                  setBanner(null);
                  fireSave(latestDocumentRef.current, latestRevision, hashDocument(latestDocumentRef.current));
                },
                onDismiss: () => {
                  if (!mountedRef.current) return;
                  setBanner(null);
                  setStatus("idle");
                },
              });
              return;
            }
            setStatus("error");
            setError(err);
          },
        },
      );
    },
    [input.systemId, mutation],
  );

  const save = useCallback(
    (document: unknown, expectedRevision: number | null) => {
      latestDocumentRef.current = document;
      const hash = hashDocument(document);
      if (hash === lastSavedHashRef.current) return;
      pendingRef.current = { document, expectedRevision, hash };
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const pending = pendingRef.current;
        if (pending !== null && mountedRef.current) {
          fireSave(pending.document, pending.expectedRevision, pending.hash);
        }
      }, debounceMs);
    },
    [fireSave, debounceMs],
  );

  return useMemo<DraftSync>(
    () => ({ save, status, banner, error }),
    [save, status, banner, error],
  );
}
