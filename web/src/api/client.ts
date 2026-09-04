export type ApiErrorCode = string;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string;

  constructor(input: { code: ApiErrorCode; message: string; status: number; requestId: string }) {
    super(input.message);
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
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
      const url = new URL(input.baseUrl + path);
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
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await response.text();
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text);
      if (!response.ok) {
        const env = parsed as { error?: { code?: string; message?: string }; requestId?: string } | null;
        throw new ApiError({
          code: env?.error?.code ?? `http_${response.status}`,
          message: env?.error?.message ?? response.statusText,
          status: response.status,
          requestId: env?.requestId ?? requestId,
        });
      }
      return parsed as never;
    },
  };
}