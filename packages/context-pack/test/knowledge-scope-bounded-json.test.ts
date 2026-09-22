import { describe, expect, it } from "bun:test";

import { BoundedJsonValueSchema } from "../src/bounded-json.js";

describe("Knowledge Scope bounded JSON text", () => {
  it("measures astral string values by UTF-8 bytes", () => {
    // Given astral text exactly at and just beyond the 65,536-byte ceiling
    const atLimit = "😀".repeat(16_384);
    const overLimit = `${atLimit}😀`;

    // When both values cross the JSON boundary
    const accepted = BoundedJsonValueSchema.safeParse(atLimit);
    const rejected = BoundedJsonValueSchema.safeParse(overLimit);

    // Then UTF-8 bytes, not UTF-16 code units, define the ceiling
    expect(accepted.success).toBe(true);
    expect(rejected.success).toBe(false);
  });

  it("applies the same UTF-8 byte ceiling to object keys", () => {
    // Given object keys exactly at and just beyond the text ceiling
    const atLimit = "😀".repeat(16_384);
    const overLimit = `${atLimit}😀`;

    // When the objects cross the recursive JSON boundary
    const accepted = BoundedJsonValueSchema.safeParse({ [atLimit]: null });
    const rejected = BoundedJsonValueSchema.safeParse({ [overLimit]: null });

    // Then oversized key text cannot bypass value limits
    expect(accepted.success).toBe(true);
    expect(rejected.success).toBe(false);
  });
});
