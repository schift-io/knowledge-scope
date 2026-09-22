import { describe, expect, it } from "bun:test";

import { compileSchemaSubset } from "../src/schema-subset.js";
import type { JsonValue } from "../src/json.js";

describe("compileSchemaSubset", () => {
  it("validates the supported object and array constraints", () => {
    // Given
    const validate = compileSchemaSubset({
      type: "object",
      properties: {
        query: { type: "string", minLength: 2 },
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    });

    // When / Then
    expect(validate({ query: "ok", tags: ["a"] })).toEqual({ valid: true });
    expect(validate({ query: "x", extra: true })).toEqual({
      valid: false,
      path: "$.query",
      reason: "minLength",
    });
  });

  it("rejects unsupported schema keywords before value validation", () => {
    // Given
    const schema = { type: "string", format: "email" };

    // When / Then
    expect(() => compileSchemaSubset(schema)).toThrow("unsupported_schema_keyword");
  });

  it("rejects schemas deeper than sixteen levels", () => {
    // Given
    let schema: unknown = { type: "string" };
    for (let depth = 0; depth < 17; depth += 1) {
      schema = { type: "array", items: schema };
    }

    // When / Then
    expect(() => compileSchemaSubset(schema)).toThrow("schema_depth_exceeded");
  });

  it("rejects duplicate required keys and contradictory bounds", () => {
    // Given / When / Then
    expect(() => compileSchemaSubset({ type: "object", required: ["id", "id"] }))
      .toThrow("unsupported_schema_keyword");
    expect(() => compileSchemaSubset({ type: "number", minimum: 2, maximum: 1 }))
      .toThrow("unsupported_schema_keyword");
  });

  it("enforces value depth even when the schema has no nested keywords", () => {
    // Given
    let value: JsonValue = null;
    for (let depth = 0; depth < 17; depth += 1) value = [value];
    const validate = compileSchemaSubset({});

    // When / Then
    expect(() => validate(value)).toThrow("schema_depth_exceeded");
  });
});
