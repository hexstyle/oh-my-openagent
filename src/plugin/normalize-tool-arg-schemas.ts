import { tool } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin"

type ToolArgSchema = ToolDefinition["args"][string]

type SchemaWithJsonSchemaOverride = ToolArgSchema & {
  _zod: ToolArgSchema["_zod"] & {
    toJSONSchema?: () => unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stripRootJsonSchemaFields(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...rest } = jsonSchema
  return rest
}

function isNullSchema(jsonSchema: Record<string, unknown>): boolean {
  return jsonSchema.type === "null"
}

function isStringSchema(jsonSchema: Record<string, unknown>): boolean {
  return jsonSchema.type === "string"
}

function isStringArraySchema(jsonSchema: Record<string, unknown>): boolean {
  if (jsonSchema.type !== "array") {
    return false
  }

  const items = jsonSchema.items
  return isRecord(items) && items.type === "string"
}

function collapseNullableUnion(
  jsonSchema: Record<string, unknown>,
  variants: Record<string, unknown>[],
): Record<string, unknown> | null {
  const nonNullVariants = variants.filter((variant) => !isNullSchema(variant))

  if (nonNullVariants.length !== 1 || variants.length !== nonNullVariants.length + 1) {
    return null
  }

  const { anyOf: _anyOf, ...schemaWithoutAnyOf } = jsonSchema
  return {
    ...nonNullVariants[0],
    ...schemaWithoutAnyOf,
    nullable: true,
  }
}

function collapseStringOrStringArrayUnion(
  jsonSchema: Record<string, unknown>,
  variants: Record<string, unknown>[],
): Record<string, unknown> | null {
  const nonNullVariants = variants.filter((variant) => !isNullSchema(variant))
  const stringVariant = nonNullVariants.find(isStringSchema)
  const stringArrayVariant = nonNullVariants.find(isStringArraySchema)

  if (!stringVariant || !stringArrayVariant || nonNullVariants.length !== 2) {
    return null
  }

  const { anyOf: _anyOf, ...schemaWithoutAnyOf } = jsonSchema

  return {
    ...stringArrayVariant,
    ...schemaWithoutAnyOf,
    nullable: variants.length !== nonNullVariants.length,
  }
}

function normalizeAnyOfUnion(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const anyOf = jsonSchema.anyOf
  if (!Array.isArray(anyOf) || jsonSchema.type !== undefined) {
    return jsonSchema
  }

  const variants = anyOf.filter(isRecord)
  if (variants.length !== anyOf.length) {
    return jsonSchema
  }

  return collapseNullableUnion(jsonSchema, variants) ?? collapseStringOrStringArrayUnion(jsonSchema, variants) ?? jsonSchema
}

function normalizeJsonSchemaValue(jsonSchema: unknown): unknown {
  if (Array.isArray(jsonSchema)) {
    return jsonSchema.map((item) => normalizeJsonSchemaValue(item))
  }

  if (!isRecord(jsonSchema)) {
    return jsonSchema
  }

  return normalizeJsonSchema(jsonSchema)
}

function normalizeJsonSchema(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(jsonSchema)) {
    normalized[key] = normalizeJsonSchemaValue(value)
  }

  return normalizeAnyOfUnion(normalized)
}

function attachJsonSchemaOverride(schema: SchemaWithJsonSchemaOverride): void {
  if (schema._zod.toJSONSchema) {
    return
  }

  schema._zod.toJSONSchema = (): Record<string, unknown> => {
    const originalOverride = schema._zod.toJSONSchema
    delete schema._zod.toJSONSchema

    try {
      return normalizeJsonSchema(stripRootJsonSchemaFields(tool.schema.toJSONSchema(schema)))
    } finally {
      schema._zod.toJSONSchema = originalOverride
    }
  }
}

export function normalizeToolArgSchemas<TDefinition extends Pick<ToolDefinition, "args">>(
  toolDefinition: TDefinition,
): TDefinition {
  for (const schema of Object.values(toolDefinition.args)) {
    attachJsonSchemaOverride(schema)
  }

  return toolDefinition
}
