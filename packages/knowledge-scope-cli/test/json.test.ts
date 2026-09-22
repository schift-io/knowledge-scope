import { describe, expect, it } from "bun:test";

import { canonicalJson, decodeUtf8Strict, parseJsonText, sha256Digest } from "../src/json.js";

describe("canonicalJson", () => {
  it("sorts object keys when serializing parsed JSON", async () => {
    // Given
    const value = parseJsonText('{"z":1,"a":{"d":2,"c":3}}', "fixture.json");

    // When
    const serialized = canonicalJson(value);
    const digest = await sha256Digest(value);

    // Then
    expect(serialized).toBe('{"a":{"c":3,"d":2},"z":1}');
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects duplicate object keys when parsing input", () => {
    // Given
    const text = '{"secret":"first","secret":"second"}';

    // When / Then
    expect(() => parseJsonText(text, "scope.json")).toThrow("duplicate_json_key");
  });

  it("rejects malformed UTF-8 instead of normalizing trust-boundary bytes", () => {
    // Given
    const malformed = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);

    // When / Then
    expect(() => decodeUtf8Strict(malformed)).toThrow("invalid_json");
  });

  it("uses deterministic Unicode code-point key ordering", () => {
    // Given
    const value = parseJsonText('{"ä":1,"z":2,"a":3}', "scope.json");

    // When / Then
    expect(canonicalJson(value)).toBe('{"a":3,"z":2,"ä":1}');
  });

  it("rejects JSON nesting beyond the parser resource ceiling", () => {
    // Given
    const text = `${"[".repeat(18)}null${"]".repeat(18)}`;

    // When / Then
    expect(() => parseJsonText(text, "scope.json")).toThrow("json_limits_exceeded");
  });

  it("preserves prototype-named keys as ordinary JSON data", () => {
    // Given
    const value = parseJsonText('{"__proto__":{"safe":true}}', "scope.json");

    // When / Then
    expect(canonicalJson(value)).toBe('{"__proto__":{"safe":true}}');
  });

  it("supports explicit depth and node ceilings for aggregate state", () => {
    // Given
    const nested = `${"[".repeat(18)}null${"]".repeat(18)}`;

    // When / Then
    expect(parseJsonText(nested, "state.json", { maxDepth: 20 })).toBeDefined();
    expect(() => parseJsonText("[null,null]", "state.json", { maxNodes: 2 }))
      .toThrow("json_limits_exceeded");
  });
});
