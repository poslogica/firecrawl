import { zodToJsonSchema as zodToJsonSchemaLib } from "zod-to-json-schema";
import type * as z3 from "zod/v3";
import { toJSONSchema, type $ZodType, type output } from "zod/v4/core";

/** A schema built with either zod 3 or zod 4 (classic or mini). */
export type AnyZodSchema = z3.ZodTypeAny | $ZodType;

/** The parsed output type of a zod 3 or zod 4 schema. */
export type InferZod<T> = T extends $ZodType
  ? output<T>
  : T extends z3.ZodTypeAny
    ? z3.infer<T>
    : never;

export function isZodSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const schema = value as Record<string, unknown>;

  const hasV3Markers =
    "_def" in schema &&
    (typeof schema.safeParse === "function" ||
      typeof schema.parse === "function");

  const hasV4Markers = "_zod" in schema && typeof schema._zod === "object";

  return hasV3Markers || hasV4Markers;
}

function isZodV4Schema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  return "_zod" in schema && typeof (schema as Record<string, unknown>)._zod === "object";
}

function tryZodV4Conversion(schema: unknown): Record<string, unknown> | null {
  if (!isZodV4Schema(schema)) return null;

  try {
    // draft-7 matches what zod-to-json-schema emits for zod 3 schemas.
    return toJSONSchema(schema as $ZodType, {
      target: "draft-7",
      unrepresentable: "any",
    }) as Record<string, unknown>;
  } catch {
    // V4 conversion not available
  }

  return null;
}

export function zodSchemaToJsonSchema(schema: unknown): Record<string, unknown> | unknown {
  if (!isZodSchema(schema)) {
    return schema;
  }

  const v4Result = tryZodV4Conversion(schema);
  if (v4Result) {
    return v4Result;
  }

  try {
    return zodToJsonSchemaLib(schema as Parameters<typeof zodToJsonSchemaLib>[0]) as Record<string, unknown>;
  } catch {
    return schema;
  }
}

export function looksLikeZodShape(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const values = Object.values(obj);
  if (values.length === 0) return false;
  return values.some(
    (v) =>
      v &&
      typeof v === "object" &&
      (v as Record<string, unknown>)._def &&
      typeof (v as Record<string, unknown>).safeParse === "function"
  );
}
