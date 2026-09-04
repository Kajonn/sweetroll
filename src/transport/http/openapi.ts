import type { FastifyInstance } from "fastify";

import { identityRouteDefinitions, type IdentityRouteDefinition } from "./identity.js";
import { systemsRouteDefinitions, type SystemsRouteDefinition } from "./systems.js";

type RouteDefinition = SystemsRouteDefinition | IdentityRouteDefinition;

export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
};

export type OpenApiOperation = {
  operationId: string;
  requestBody?: { content: { "application/json": { schema: unknown } } };
  parameters: OpenApiParameter[];
  responses: Record<string, { description?: string; content?: { "application/json": { schema: unknown } } }>;
};

export type OpenApiParameter = {
  name: string;
  in: "path" | "query";
  required?: boolean;
  schema: unknown;
};

function toOpenApiPath(path: string): string {
  return path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
}

function parametersFromSchema(schema: Record<string, unknown> | undefined): OpenApiParameter[] {
  if (schema === undefined) return [];
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const required = new Set<string>((schema as { required?: string[] }).required ?? []);
  const out: OpenApiParameter[] = [];
  for (const [name, propertySchema] of Object.entries(properties)) {
    out.push({ name, in: "query", required: required.has(name), schema: propertySchema });
  }
  return out;
}

function pathParametersFromSchema(schema: Record<string, unknown> | undefined): OpenApiParameter[] {
  if (schema === undefined) return [];
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: "path",
    required: true,
    schema: propertySchema,
  }));
}

function responseMapFromSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, { description?: string; content?: { "application/json": { schema: unknown } } }> {
  if (schema === undefined) return {};
  const out: Record<string, { description?: string; content?: { "application/json": { schema: unknown } } }> = {};
  for (const [status, value] of Object.entries(schema)) {
    out[status] = {
      content: { "application/json": { schema: value as unknown } },
    };
  }
  return out;
}

function definitionToOperation(definition: RouteDefinition): OpenApiOperation {
  const schema = definition.schema as {
    body?: unknown;
    params?: Record<string, unknown>;
    querystring?: Record<string, unknown>;
    response?: Record<string, unknown>;
  };
  return {
    operationId: definition.operationId,
    ...(schema.body !== undefined
      ? { requestBody: { content: { "application/json": { schema: schema.body } } } }
      : {}),
    parameters: [
      ...pathParametersFromSchema(schema.params),
      ...parametersFromSchema(schema.querystring),
    ],
    responses: responseMapFromSchema(schema.response),
  };
}

export function buildOpenApiDocument(_app: FastifyInstance): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  const routeDefinitions: readonly RouteDefinition[] = [...systemsRouteDefinitions, ...identityRouteDefinitions];
  for (const definition of routeDefinitions) {
    const path = toOpenApiPath(definition.path);
    paths[path] ??= {};
    paths[path][definition.method] = definitionToOperation(definition);
  }
  return {
    openapi: "3.1.0",
    info: { title: "Sweetroll HTTP API", version: "1.0.0" },
    paths,
    components: { schemas: {}, responses: {} },
  };
}
