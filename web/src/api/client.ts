export type ApiErrorCode = string;

export type ApiDiagnostic = { code: string; path: string; message: string };

export type RuntimeDiagnostic = {
  validationId: string;
  severity: "error" | "warning";
  message: string;
  targetDefinitionId: string;
};

export type CacheDisposition = "retain" | "replace" | "purge";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string;
  readonly latestRevision: number | null;
  readonly diagnostics: ReadonlyArray<ApiDiagnostic>;
  readonly runtimeDiagnostics: ReadonlyArray<RuntimeDiagnostic>;
  readonly changedDefinitionIds: ReadonlyArray<string> | undefined;
  readonly activityCursor: string | null;
  readonly cacheDisposition: CacheDisposition | undefined;

  constructor(input: {
    code: ApiErrorCode;
    message: string;
    status: number;
    requestId: string;
    latestRevision: number | null;
    diagnostics: ReadonlyArray<ApiDiagnostic>;
    runtimeDiagnostics?: ReadonlyArray<RuntimeDiagnostic>;
    changedDefinitionIds?: ReadonlyArray<string> | null;
    activityCursor?: string | null;
    cacheDisposition?: CacheDisposition | null;
  }) {
    super(input.message);
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.latestRevision = input.latestRevision;
    this.diagnostics = input.diagnostics;
    this.runtimeDiagnostics = input.runtimeDiagnostics ?? [];
    this.changedDefinitionIds = input.changedDefinitionIds ?? undefined;
    this.activityCursor = input.activityCursor ?? null;
    this.cacheDisposition = input.cacheDisposition ?? undefined;
  }
}

export type ApiClient = {
  fetch<TResp = unknown, TBody = unknown>(
    method: string,
    path: string,
    init?: {
      body?: TBody;
      headers?: Record<string, string>;
      query?: Record<string, string | number | null | undefined>;
    },
  ): Promise<TResp>;
};

function splitDiagnostics(raw: ReadonlyArray<Record<string, unknown>> | undefined): {
  authoring: ApiDiagnostic[];
  runtime: RuntimeDiagnostic[];
} {
  const authoring: ApiDiagnostic[] = [];
  const runtime: RuntimeDiagnostic[] = [];
  for (const entry of raw ?? []) {
    if (typeof entry.validationId === "string" && typeof entry.targetDefinitionId === "string") {
      runtime.push({
        validationId: entry.validationId,
        severity: entry.severity === "warning" ? "warning" : "error",
        message: String(entry.message ?? ""),
        targetDefinitionId: entry.targetDefinitionId,
      });
    } else if (typeof entry.code === "string" && typeof entry.path === "string") {
      authoring.push({ code: entry.code, path: entry.path, message: String(entry.message ?? "") });
    }
  }
  return { authoring, runtime };
}

export type CreateApiClientInput = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export function createApiClient(input: CreateApiClientInput): ApiClient {
  const f = input.fetch ?? fetch;
  return {
    async fetch(method, path, init) {
      const url = new URL(
        input.baseUrl + path,
        typeof document === "undefined" ? undefined : document.baseURI,
      );
      if (init?.query !== undefined) {
        for (const [k, v] of Object.entries(init.query)) {
          if (v === null || v === undefined) continue;
          url.searchParams.set(k, String(v));
        }
      }
      const headers: Record<string, string> = { accept: "application/json", ...(init?.headers ?? {}) };
      const requestId = crypto.randomUUID();
      headers["x-request-id"] = requestId;
      const response = await f(url.toString(), {
        method,
        credentials: "include",
        headers,
        ...(init?.body === undefined
          ? {}
          : { body: JSON.stringify(init.body), headers: { ...headers, "content-type": "application/json" } }),
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (response.ok) {
            // A 2xx whose body did not parse is an uncertain mutation outcome,
            // never a silent success. Surface it as an error so callers retain
            // the exact frozen request instead of issuing a fresh key.
            throw new ApiError({
              code: "malformed_response",
              message: "The server returned an unparseable response.",
              status: response.status,
              requestId,
              latestRevision: null,
              diagnostics: [],
            });
          }
          parsed = null;
        }
      }
      if (!response.ok) {
        const env = parsed as {
          error?: {
            code?: string;
            message?: string;
            latestRevision?: number | null;
            diagnostics?: ReadonlyArray<Record<string, unknown>>;
            changedDefinitionIds?: string[] | null;
            activityCursor?: string | null;
            cacheDisposition?: CacheDisposition | null;
          };
          requestId?: string;
        } | null;
        const err = env?.error;
        const { authoring, runtime } = splitDiagnostics(err?.diagnostics);
        throw new ApiError({
          code: err?.code ?? `http_${response.status}`,
          message: err?.message ?? response.statusText,
          status: response.status,
          requestId: env?.requestId ?? requestId,
          latestRevision: err?.latestRevision ?? null,
          diagnostics: authoring,
          runtimeDiagnostics: runtime,
          changedDefinitionIds: err?.changedDefinitionIds ?? [],
          activityCursor: err?.activityCursor ?? null,
          cacheDisposition: err?.cacheDisposition ?? null,
        });
      }
      return parsed as never;
    },
  };
}