import { describe, expect, jest, test } from "@jest/globals";
import { z as z3 } from "zod3";
import { z as z4 } from "zod";
import * as zm from "zod/mini";
import { startExtract } from "../../../v2/methods/extract";
import { ensureValidFormats } from "../../../v2/utils/validation";
import {
  isZodSchema,
  zodSchemaToJsonSchema,
  type AnyZodSchema,
  type InferZod,
} from "../../../utils/zodSchemaToJson";
import type { FormatOption } from "../../../v2/types";

// The SDK depends on zod 4 but must keep accepting zod 3 schemas, which is
// what existing callers on zod 3 pass in.
const schemas = {
  "zod 3": z3.object({ title: z3.string(), price: z3.number().optional() }),
  "zod 4": z4.object({ title: z4.string(), price: z4.number().optional() }),
  "zod 4 mini": zm.object({ title: zm.string(), price: zm.optional(zm.number()) }),
};

describe("zod 3 and zod 4 schemas", () => {
  test.each(Object.entries(schemas))("%s schema converts to an object JSON schema", (_, schema) => {
    expect(isZodSchema(schema)).toBe(true);
    const json = zodSchemaToJsonSchema(schema) as Record<string, any>;
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties)).toEqual(["title", "price"]);
    expect(json.properties.title.type).toBe("string");
    expect(json.properties.price.type).toBe("number");
    expect(json.required).toEqual(["title"]);
  });

  test.each(Object.entries(schemas))("%s schema is sent as JSON schema by startExtract", async (_, schema) => {
    const post = jest.fn().mockResolvedValue({ status: 200, data: { id: "extract-job" } });

    await startExtract({ post } as any, { urls: ["https://example.com"], schema });

    const body = (post.mock.calls[0] as any[])[1] as Record<string, any>;
    expect(isZodSchema(body.schema)).toBe(false);
    expect(body.schema.type).toBe("object");
    expect(body.schema.required).toEqual(["title"]);
  });

  test.each(Object.entries(schemas))("%s schema in a json format is converted", (_, schema) => {
    const formats: FormatOption[] = [{ type: "json", schema }];
    ensureValidFormats(formats);
    const json = (formats[0] as any).schema as Record<string, any>;
    expect(isZodSchema(json)).toBe(false);
    expect(json.type).toBe("object");
  });

  test("schemas from both versions satisfy the public types", () => {
    const accepted: AnyZodSchema[] = Object.values(schemas);
    expect(accepted).toHaveLength(3);

    type Expected = { title: string; price?: number | undefined };
    const fromZod3: InferZod<(typeof schemas)["zod 3"]> = { title: "a" };
    const fromZod4: InferZod<(typeof schemas)["zod 4"]> = { title: "a", price: 1 };
    const fromMini: InferZod<(typeof schemas)["zod 4 mini"]> = { title: "a" };
    const all: Expected[] = [fromZod3, fromZod4, fromMini];
    expect(all).toHaveLength(3);
  });
});
