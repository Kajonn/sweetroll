import type { Static, TSchema } from "@sinclair/typebox";
import { Ajv } from "ajv";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Pool } from "pg";

import type { CharacterError, Characters, CharacterView } from "../../../characters/index.js";
import type { Identity } from "../../../identity/index.js";
import type { PersonalTokenScope } from "../../../identity/personal-tokens.js";
import type { AppError, AuthoringWorkspace, RequestContext, SystemAuthoring } from "../../../systems/authoring.js";
import { documentDiagnosticPointers } from "../../../systems/implementation/authoring/assess.js";
import { PACKAGE_LIMITS } from "../../../systems/implementation/package/limits.js";
import { SystemDocumentV1Schema } from "../../../systems/implementation/package/schema/document.js";
import { strictInputCompiler } from "../strictValidation.js";
import { consumeRequest, type RateBucket } from "./rate-limit.js";
import * as s from "./schemas.js";

export const publicApiPrefix = "/api/v1";
const documentBodyLimit = PACKAGE_LIMITS.encodedBytes + 4096;
const commandBodyLimit = 128 * 1024;
const bodyValidator = new Ajv({ strict: false });
bodyValidator.addFormat("uuid", /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);

const errorStatuses = {
  400: "Invalid request",
  401: "Missing, expired, revoked or invalid bearer credential",
  403: "Token lacks the required scope",
  404: "Resource is missing or inaccessible",
  409: "Revision, idempotency or lifecycle conflict",
  413: "Payload exceeds the allowed size",
  415: "Unsupported media type",
  422: "Document or field value failed validation",
  429: "Account request limit exceeded",
  500: "Internal error",
  503: "Temporarily unavailable",
};

const errorExamples: Partial<Record<keyof typeof errorStatuses, { code: string; message: string; latestRevision?: number }>> = {
  401: { code: "unauthorized", message: "A valid bearer token is required." },
  403: { code: "insufficient_scope", message: "The token lacks the required scope." },
  409: { code: "stale_revision", message: "The draft was modified by another request.", latestRevision: 3 },
  429: { code: "rate_limited", message: "The account request limit was reached." },
};

const errorResponses = Object.fromEntries(Object.entries(errorStatuses).map(([status, description]) => {
  const example = errorExamples[Number(status) as keyof typeof errorStatuses];
  return [status, {
    description,
    content: { "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
      ...(example ? { example: { error: example, requestId: "request-id" } } : {}),
    } },
    ...(status === "429" ? { headers: { "Retry-After": { schema: { type: "integer" } } } } : {}),
  }];
}));

const outputSchemas = {
  SystemPage: s.systemPage, Workspace: s.workspace, Assessment: s.assessment, Publication: s.publication,
  CreationVersions: s.creationVersions, CreationOptions: s.creationOptions,
  CharacterPage: s.characterPage, CharacterSheet: s.characterSheet, CharacterMutation: s.characterMutation,
};

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });

type Dependencies = { identity: Identity; authoring: SystemAuthoring; characters: Characters; pool: Pool };
type InputSchema = { params?: TSchema; querystring?: TSchema; body?: TSchema };
type Infer<S, K extends keyof InputSchema> = S extends Record<K, TSchema> ? Static<S[K]> : never;
type Operation<S> = {
  method: "GET" | "POST" | "PUT";
  path: string;
  id: string;
  description: string;
  scope: PersonalTokenScope;
  input: S;
  output: keyof typeof outputSchemas;
  created?: true;
  document?: true;
  example?: unknown;
  bucket?: RateBucket;
  fieldErrorPath?: "initialValues" | "value";
};
type Failure = AppError | CharacterError;
type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

function failure(reply: FastifyReply, requestId: string, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message }, requestId });
}

function packageDiagnostic(diagnostic: { code: string; path: string; message: string }) {
  const path = diagnostic.path.startsWith("/") ? diagnostic.path : "";
  return { ...diagnostic, path, severity: "error" as const };
}

function sendResult<T>(
  reply: FastifyReply,
  requestId: string,
  status: number,
  result: Result<T>,
  fieldErrorPath?: "initialValues" | "value",
) {
  if (result.ok) return reply.code(status).send(result.value);
  const error = result.error;
  const statuses: Record<Failure["code"], number> = {
    bad_request: 400, too_large: 413, unprocessable: 422, invalid_package: 422, invalid_value: 422,
    not_found: 404, conflict: 409, idempotency_mismatch: 409, command_in_progress: 409,
    result_unavailable: 409, internal: 500, temporarily_unavailable: 503,
  };
  const code = error.code === "conflict" && error.latestRevision !== undefined ? "stale_revision" : error.code;
  const diagnostics = (error.diagnostics ?? []).map((entry) => "path" in entry
    ? packageDiagnostic(entry)
    : { code: entry.validationId, severity: entry.severity, path: "", message: entry.message });
  if (fieldErrorPath !== undefined && "definitionId" in error && error.definitionId !== undefined) {
    const field = error.definitionId.replaceAll("~", "~0").replaceAll("/", "~1");
    const path = fieldErrorPath === "initialValues" ? `/initialValues/${field}` : "/value";
    diagnostics.push(packageDiagnostic({ code, message: error.message, path }));
  }
  return reply.code(statuses[error.code]).send({
    requestId,
    error: {
      code, message: error.message, latestRevision: error.latestRevision,
      ...(diagnostics.length ? { diagnostics } : {}),
    },
  });
}

function map<T, U>(result: Result<T>, project: (value: T) => U): Result<U> {
  return result.ok ? { ok: true, value: project(result.value) } : result;
}

function assessment({ ok, diagnostics }: ReturnType<SystemAuthoring["validateDocument"]>) {
  return { valid: ok, diagnostics: diagnostics.map(packageDiagnostic) };
}

function workspace(value: AuthoringWorkspace) {
  const draft = value.draft === null ? null : {
    revision: value.draft.revision,
    document: value.draft.document,
    updatedAt: new Date(value.draft.updatedAt).toISOString(),
  };
  return {
    system: value.system, draft, versions: value.versions,
    assessment: assessment({
      ...value.assessment,
      diagnostics: documentDiagnosticPointers(draft?.document ?? null, value.assessment.diagnostics),
    }),
  };
}

function characterSheet(character: CharacterView) {
  const { characterId, systemVersionId, entityDefinitionId, name, revision, lifecycle, createdAt, updatedAt, derivedValues, validations } = character;
  return {
    characterId, systemVersionId, entityDefinitionId, name, revision, lifecycle, createdAt, updatedAt,
    values: character.state.values, derivedValues, validations,
  };
}

function characterMutation({ characterId, revision }: CharacterView) {
  return { characterId, revision };
}

export function buildPublicApi({ identity, authoring, characters, pool }: Dependencies): FastifyPluginAsync {
  return async (app) => {
    const paths: Record<string, Record<string, unknown>> = {};
    app.addHook("onRequest", async (_request, reply) => {
      reply.header("cache-control", "no-store");
    });
    app.setNotFoundHandler((request, reply) =>
      failure(reply, request.id, 404, "not_found", "The requested endpoint does not exist."));
    app.setErrorHandler((cause, request, reply) => {
      const error = cause as { statusCode?: number; code?: string; validation?: unknown };
      const status = error.statusCode ?? 500;
      if (status >= 500) {
        request.log.error({ requestId: request.id, code: error.code }, "public API request failed");
        return failure(reply, request.id, 500, "internal", "An internal error occurred.");
      }
      const code = status === 413 ? "too_large" : status === 415 ? "unsupported_media_type" : "bad_request";
      return failure(reply, request.id, status, code, error.validation ? "The request does not match the API schema." : "The request could not be parsed.");
    });

    function route<S extends InputSchema, T>(
      operation: Operation<S>,
      run: (ctx: RequestContext, request: {
        params: Infer<S, "params">; query: Infer<S, "querystring">; body: Infer<S, "body">;
      }) => Result<T> | Promise<Result<T>>,
    ) {
      const success = operation.created ? 201 : 200;
      const statuses = Object.entries(errorStatuses);
      const response = { [success]: outputSchemas[operation.output], ...Object.fromEntries(statuses.map(([code]) => [code, s.errorEnvelope])) };
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
        security: [{ bearerAuth: [] }], "x-required-scope": operation.scope,
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(body ? {
          "x-max-body-bytes": operation.document ? documentBodyLimit : commandBodyLimit,
          requestBody: { required: true, content: { "application/json": {
            schema: body, ...(operation.example ? { example: operation.example } : {}),
          } } },
        } : {}),
        responses: {
          [success]: { description: operation.created ? "Created" : "OK", content: { "application/json": { schema: schemaRef(operation.output) } } },
          ...Object.fromEntries(statuses.map(([status]) => [
            status, { $ref: `#/components/responses/${status}` },
          ])),
        },
      };

      const actors = new WeakMap<object, string>();
      app.route<{ Params: Infer<S, "params">; Querystring: Infer<S, "querystring">; Body: Infer<S, "body"> }>({
        method: operation.method, url: operation.path, schema,
        config: { bearerOnly: true },
        bodyLimit: operation.document ? documentBodyLimit : commandBodyLimit,
        validatorCompiler: (input) => input.httpPart === "body" ? bodyValidator.compile(input.schema) : strictInputCompiler(input),
        async onRequest(request, reply) {
          const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.authorization ?? "")?.[1];
          const credential = token === undefined ? null : await identity.personalTokens.resolve(token);
          if (credential === null) {
            reply.header("www-authenticate", "Bearer");
            return failure(reply, request.id, 401, "unauthorized", "A valid bearer token is required.");
          }
          if (!credential.scopes.includes(operation.scope)) {
            return failure(reply, request.id, 403, "insufficient_scope", "The token lacks the required scope.");
          }
          if (!await consumeRequest(pool, credential.actorId, "general")
            || (operation.bucket && !await consumeRequest(pool, credential.actorId, operation.bucket))) {
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
          return sendResult(reply, request.id, success, result, operation.fieldErrorPath);
        },
      });
    }

    route({
      method: "GET", path: "/systems", id: "listSystems", description: "List systems owned by the account.",
      scope: "systems:read", input: { querystring: s.systemQuery }, output: "SystemPage",
    }, (ctx, { query }) => authoring.list(ctx, { limit: query.limit ?? 25, cursor: query.cursor ?? null }));

    route({
      method: "POST", path: "/systems", id: "createSystem", description: "Create a private system and blank draft.",
      scope: "systems:write", input: { body: s.createSystem }, output: "Workspace", created: true,
      example: { name: "Wayfarer", idempotencyKey: "system-create-1" },
    }, async (ctx, { body }) => map(await authoring.createDraft(ctx, {
      source: { kind: "blank", name: body.name }, idempotencyKey: body.idempotencyKey,
    }), workspace));

    route({
      method: "GET", path: "/systems/:systemId", id: "readSystem", description: "Read the current draft and published versions of an owned system.",
      scope: "systems:read", input: { params: s.systemId }, output: "Workspace",
    }, async (ctx, { params }) => map(await authoring.open(ctx, params.systemId), workspace));

    route({
      method: "POST", path: "/systems/validate", id: "validateSystem",
      description: "Assess a document without persisting it. Publication checks stored assets and version compatibility separately.",
      scope: "systems:write", input: { body: s.validateDocument }, output: "Assessment", document: true, bucket: "validate",
    }, (_ctx, { body }) => ({ ok: true, value: assessment(authoring.validateDocument(body.document)) }));

    route({
      method: "PUT", path: "/systems/:systemId/draft", id: "saveSystemDraft", description: "Replace an owned system draft at the supplied revision.",
      scope: "systems:write", input: { params: s.systemId, body: s.saveDraft }, output: "Workspace", document: true,
    }, async (ctx, { params, body }) => map(await authoring.saveDraft(ctx, { ...params, ...body }), workspace));

    route({
      method: "POST", path: "/systems/:systemId/publish", id: "publishSystemVersion", description: "Publish the exact draft revision as an immutable system version.",
      scope: "systems:write", input: { params: s.systemId, body: s.publishDraft }, output: "Publication", created: true, bucket: "publish",
      example: { expectedRevision: 2, semanticVersion: "1.0.0", idempotencyKey: "publish-1" },
    }, (ctx, { params, body }) => authoring.publish(ctx, {
      ...params, ...body, releaseNotes: body.releaseNotes ?? "", acknowledgeBreaking: body.acknowledgeBreaking ?? false,
    }));

    route({
      method: "GET", path: "/characters/creation-versions", id: "listCharacterCreationVersions",
      description: "Discover active published versions of owned or public systems.",
      scope: "characters:read", input: { querystring: s.creationVersionsQuery }, output: "CreationVersions",
    }, (ctx, { query }) => characters.listCreationVersions(ctx, query));

    route({
      method: "GET", path: "/characters/creation-options", id: "getCharacterCreationOptions",
      description: "Read entity types and writable initial fields for a usable exact version, including known link-only versions.",
      scope: "characters:read", input: { querystring: s.creationOptionsQuery }, output: "CreationOptions",
    }, (ctx, { query }) => characters.creationOptions(ctx, { ...query, includeFields: true }));

    route({
      method: "GET", path: "/characters", id: "listCharacters", description: "List standalone characters owned by the account.",
      scope: "characters:read", input: { querystring: s.characterQuery }, output: "CharacterPage",
    }, (ctx, { query }) => characters.list(ctx, { limit: query.limit ?? 25, cursor: query.cursor ?? null }));

    route({
      method: "POST", path: "/characters", id: "createCharacter", description: "Create a standalone character pinned to the supplied published version.",
      scope: "characters:write", input: { body: s.createCharacter }, output: "CharacterMutation", created: true,
      fieldErrorPath: "initialValues",
      example: {
        name: "Rowan", systemVersionId: "00000000-0000-4000-8000-000000000001", entityDefinitionId: "character",
        initialValues: { ability: 12 }, idempotencyKey: "character-create-1",
      },
    }, async (ctx, { body }) => map(await characters.create(ctx, body), characterMutation));

    route({
      method: "GET", path: "/characters/:characterId", id: "readCharacter", description: "Read the stored and derived sheet values of an owned standalone character.",
      scope: "characters:read", input: { params: s.characterId }, output: "CharacterSheet",
    }, async (ctx, { params }) => map(await characters.open(ctx, params.characterId, { standaloneOnly: true }), characterSheet));

    route({
      method: "POST", path: "/characters/:characterId/fields/:fieldId/set", id: "setCharacterField",
      description: "Set one editable field on an owned standalone character at the supplied revision.",
      scope: "characters:write", input: { params: s.fieldId, body: s.setField }, output: "CharacterMutation",
      fieldErrorPath: "value",
      example: { value: 14, expectedRevision: 1, idempotencyKey: "field-set-1" },
    }, async (ctx, { params, body }) => map(
      await characters.apply(ctx, { kind: "setField", ...params, ...body }, { standaloneOnly: true }),
      ({ character }) => characterMutation(character),
    ));

    paths["/openapi.json"] = { get: {
      operationId: "getOpenApiDocument", description: "Download the public API contract.",
      security: [], responses: { 200: { description: "OpenAPI 3.1 document", content: { "application/json": {} } } },
    } };
    app.get("/openapi.json", { config: { bearerOnly: true } }, async () => ({
      openapi: "3.1.0",
      info: { title: "Sweetroll public API", version: "1.0.0" },
      servers: [{ url: publicApiPrefix }],
      paths,
      components: {
        responses: errorResponses,
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
        schemas: {
          ...outputSchemas,
          // Keep the document schema in a single OpenAPI component.
          Workspace: JSON.parse(JSON.stringify(s.workspace, (key, value: unknown) =>
            key === "document" ? schemaRef("SystemDocument") : value)),
          SystemDocument: SystemDocumentV1Schema,
          Error: s.errorEnvelope,
        },
      },
    }));
  };
}
