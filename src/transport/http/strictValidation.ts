import { Ajv } from "ajv";
import type { FastifySchemaCompiler, FastifySchema } from "fastify";

// Fastify normally removes unknown properties. Data-only template and entry
// commands must reject supplied definitions instead of silently accepting them.
const ajv = new Ajv({
  coerceTypes: "array",
  useDefaults: true,
  removeAdditional: false,
  strict: false,
});
ajv.addFormat(
  "uuid",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);
export const strictInputCompiler: FastifySchemaCompiler<FastifySchema> = ({
  schema,
}) => ajv.compile(schema);
