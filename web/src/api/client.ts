export type ApiErrorCode = string;

export type ApiDiagnostic = { code: string; path: string; message: string };

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string;
  readonly latestRevision: number | null;
  readonly diagnostics: ReadonlyArray<ApiDiagnostic>;

  constructor(input: {
    code: ApiErrorCode;
    message: string;
    status: number;
    requestId: string;
    latestRevision: number | null;
    diagnostics: ReadonlyArray<ApiDiagnostic>;
  }) {
    super(input.message);
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.latestRevision = input.latestRevision;
    this.diagnostics = input.diagnostics;
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
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text);
      if (!response.ok) {
        const env = parsed as {
          error?: {
            code?: string;
            message?: string;
            latestRevision?: number | null;
            diagnostics?: ReadonlyArray<ApiDiagnostic>;
          };
          requestId?: string;
        } | null;
        const err = env?.error;
        throw new ApiError({
          code: err?.code ?? `http_${response.status}`,
          message: err?.message ?? response.statusText,
          status: response.status,
          requestId: env?.requestId ?? requestId,
          latestRevision: err?.latestRevision ?? null,
          diagnostics: err?.diagnostics ?? [],
        });
      }
      return parsed as never;
    },
  };
}