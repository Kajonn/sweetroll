import type { Static, TSchema } from "@sinclair/typebox";
import { Ajv } from "ajv";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";

import type { CampaignError } from "../../../campaigns/index.js";
import type { CharacterError } from "../../../characters/index.js";
import type { Identity } from "../../../identity/index.js";
import { grantsScope, type PersonalTokenScope } from "../../../identity/personal-tokens.js";
import type { ImageAttachmentError } from "../../../platform/image-attachment.js";
import type { AppError, RequestContext } from "../../../systems/authoring.js";
import { PACKAGE_LIMITS } from "../../../systems/implementation/package/limits.js";
import { strictInputCompiler } from "../strictValidation.js";
import { consumeRequestBudgets, type RateBucket } from "./rate-limit.js";
import * as s from "./schemas.js";

export const documentBodyLimit = PACKAGE_LIMITS.encodedBytes + 4096;
export const commandBodyLimit = 128 * 1024;
export const imageBodyLimit = 8 * 1024 * 1024;
const bodyValidator = new Ajv({ strict: false });
bodyValidator.addFormat("uuid", /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
bodyValidator.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)));

export const errorStatuses = {
  400: "Invalid request",
  401: "Missing, expired, revoked or invalid bearer credential",
  403: "Token lacks a required scope, or the caller's campaign role does not permit the command",
  404: "Resource is missing or inaccessible",
  409: "Revision, idempotency or lifecycle conflict",
  413: "Payload exceeds the allowed size",
  415: "Unsupported media type",
  422: "Document or field value failed validation",
  429: "Account request limit exceeded",
  500: "Internal error",
  503: "Temporarily unavailable",
};

export type Scope = PersonalTokenScope;
export type InputSchema = { params?: TSchema; querystring?: TSchema; body?: TSchema };
export type Infer<S, K extends keyof InputSchema> = S extends Record<K, TSchema> ? Static<S[K]> : never;
export type Failure = AppError | CharacterError | ImageAttachmentError | CampaignError;
export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };
export type Binary = { contentType: string; bytes: Buffer | Uint8Array };

export type Operation<S, O extends string> = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  id: string;
  description: string;
  /** Every listed scope is required. */
  scope: Scope | readonly Scope[];
  input: S;
  /** A component schema name, or `binary` for raw image bytes. */
  output: O | "binary";
  created?: true;
  document?: true;
  bodyLimit?: number;
  example?: unknown;
  bucket?: Exclude<RateBucket, "general">;
  fieldErrorPath?: "initialValues" | "value";
};

export type Handler<S> = (ctx: RequestContext, request: {
  params: Infer<S, "params">; query: Infer<S, "querystring">; body: Infer<S, "body">;
}) => Result<unknown> | Promise<Result<unknown>>;

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export function map<T, U>(result: Result<T>, project: (value: T) => U): Result<U> {
  return result.ok ? { ok: true, value: project(result.value) } : result;
}

/** Converts module dates to ISO strings and drops undefined members. */
export function wire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function failure(reply: FastifyReply, requestId: string, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message }, requestId });
}

export function packageDiagnostic(diagnostic: { code: string; path: string; message: string }) {
  const path = diagnostic.path.startsWith("/") ? diagnostic.path : "";
  return { ...diagnostic, path, severity: "error" as const };
}

const statuses: Record<Failure["code"], number> = {
  bad_request: 400, too_large: 413, export_too_large: 413, unprocessable: 422, invalid_package: 422, invalid_value: 422,
  not_found: 404, conflict: 409, idempotency_mismatch: 409, command_in_progress: 409, forbidden: 403,
  result_unavailable: 409, rate_limited: 429, internal: 500, temporarily_unavailable: 503,
};

export function sendResult(
  reply: FastifyReply,
  requestId: string,
  status: number,
  result: Result<unknown>,
  fieldErrorPath?: "initialValues" | "value",
) {
  if (result.ok) return reply.code(status).send(result.value);
  const error = result.error;
  const code = error.code === "conflict" && error.latestRevision !== undefined && error.latestRevision !== null
    ? "stale_revision" : error.code;
  const diagnostics = (("diagnostics" in error ? error.diagnostics : undefined) ?? []).map((entry) => "path" in entry
    ? packageDiagnostic(entry)
    : { code: entry.validationId, severity: entry.severity, path: "", message: entry.message });
  if (fieldErrorPath !== undefined && "definitionId" in error && error.definitionId !== undefined) {
    const field = error.definitionId.replaceAll("~", "~0").replaceAll("/", "~1");
    const path = fieldErrorPath === "initialValues" ? `/initialValues/${field}` : "/value";
    diagnostics.push(packageDiagnostic({ code, message: error.message, path }));
  }
  const httpStatus = statuses[error.code] ?? 500;
  if (httpStatus === 429) reply.header("retry-after", "60");
  return reply.code(httpStatus).send({
    requestId,
    error: {
      code,
      message: httpStatus >= 500 && error.code === "internal" ? "An internal error occurred." : error.message,
      latestRevision: error.latestRevision ?? undefined,
      ...(diagnostics.length ? { diagnostics } : {}),
    },
  });
}

export const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });

type RouterInput = {
  app: FastifyInstance;
  identity: Identity;
  pool: Pool;
  outputSchemas: Record<string, TSchema>;
};

/**
 * One public route: Bearer resolution, every required scope, account
 * quotas, strict inputs and an OpenAPI entry generated from the same
 * definition. Module results map to the shared error envelope.
 */
export function createRouter({ app, identity, pool, outputSchemas }: RouterInput) {
  const paths: Record<string, Record<string, unknown>> = {};

  function route<S extends InputSchema, O extends string>(operation: Operation<S, O>, run: Handler<S>) {
    const scopes: readonly Scope[] = typeof operation.scope === "string" ? [operation.scope] : operation.scope;
    const binary = operation.output === "binary";
    const success = operation.created ? 201 : 200;
    const bodyLimit = operation.bodyLimit ?? (operation.document ? documentBodyLimit : commandBodyLimit);
    const errorCodes = Object.keys(errorStatuses);
    const outputSchema = binary ? undefined : outputSchemas[operation.output];
    if (!binary && outputSchema === undefined) throw new Error(`Unknown public API output ${operation.output}.`);
    const response = {
      ...(outputSchema ? { [success]: outputSchema } : {}),
      ...Object.fromEntries(errorCodes.map((code) => [code, s.errorEnvelope])),
    };
    const path = operation.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const schema = { ...operation.input, response };
    const body = operation.document && schema.body
      ? { ...schema.body, properties: { ...schema.body.properties, document: schemaRef("SystemDocument") } }
      : schema.body;
    const parameters = (["params", "querystring"] as const).flatMap((location) => {
      const parameterSchema = schema[location];
      return Object.entries(parameterSchema?.properties ?? {}).map(([name, property]) => ({
        name, in: location === "params" ? "path" : "query",
        required: parameterSchema?.required?.includes(name) ?? false, schema: property,
      }));
    });
    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = {
      operationId: operation.id, description: operation.description,
      security: [{ bearerAuth: [] }], "x-required-scopes": scopes,
      ...(operation.bucket ? { "x-rate-bucket": operation.bucket } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(body ? {
        "x-max-body-bytes": bodyLimit,
        requestBody: { required: true, content: { "application/json": {
          schema: body, ...(operation.example ? { example: operation.example } : {}),
        } } },
      } : {}),
      responses: {
        [success]: binary
          ? {
            description: "Image bytes; responses are private and never cached",
            content: { "image/png": { schema: { type: "string", format: "binary" } },
              "image/jpeg": { schema: { type: "string", format: "binary" } },
              "image/webp": { schema: { type: "string", format: "binary" } } },
          }
          : { description: operation.created ? "Created" : "OK", content: { "application/json": { schema: schemaRef(operation.output) } } },
        ...Object.fromEntries(errorCodes.map((status) => [status, { $ref: `#/components/responses/${status}` }])),
      },
    };

    const actors = new WeakMap<object, string>();
    app.route<{ Params: Infer<S, "params">; Querystring: Infer<S, "querystring">; Body: Infer<S, "body"> }>({
      method: operation.method, url: operation.path, schema,
      config: { bearerOnly: true },
      bodyLimit,
      validatorCompiler: (input) => input.httpPart === "body" ? bodyValidator.compile(input.schema) : strictInputCompiler(input),
      async onRequest(request, reply) {
        const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.authorization ?? "")?.[1];
        const credential = token === undefined ? null : await identity.personalTokens.resolve(token);
        if (credential === null) {
          reply.header("www-authenticate", "Bearer");
          return failure(reply, request.id, 401, "unauthorized", "A valid bearer token is required.");
        }
        if (!scopes.every((scope) => grantsScope(credential.scopes, scope))) {
          return failure(reply, request.id, 403, "insufficient_scope", "The token lacks the required scope.");
        }
        if (!await consumeRequestBudgets(pool, credential.actorId, "ordinary", operation.bucket)) {
          reply.header("retry-after", "60");
          return failure(reply, request.id, 429, "rate_limited", "The account request limit was reached.");
        }
        actors.set(request, credential.actorId);
      },
      async handler(request, reply) {
        const actorId = actors.get(request);
        if (actorId === undefined) throw new Error("Public API request has no authorized actor.");
        const result = await run({ actorId, requestId: request.id }, {
          params: request.params as Infer<S, "params">,
          query: request.query as Infer<S, "querystring">,
          body: request.body as Infer<S, "body">,
        });
        if (result.ok && operation.method !== "GET") {
          // Audit trail for script writes: operation, account and request
          // only. Bodies carry invitation tokens and image data and are never logged.
          request.log.info({ actorId, operationId: operation.id, requestId: request.id }, "public API command");
        }
        if (binary && result.ok) {
          const { contentType, bytes } = result.value as Binary;
          reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff");
          return reply.code(200).type(contentType).send(Buffer.from(bytes));
        }
        return sendResult(reply, request.id, success, result, operation.fieldErrorPath);
      },
    });
  }

  return { route, paths };
}

export type Route = ReturnType<typeof createRouter>["route"];
