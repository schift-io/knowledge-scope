import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { canonicalJson, digestCanonicalJson } from "../src/canonical.js";
import { BoundedJsonValueSchema } from "../src/bounded-json.js";
import { KnowledgeScopeLockError, KnowledgeScopeLockSchema, buildKnowledgeScopeLock, digestKnowledgeScopeDefinition, verifyKnowledgeScopeLock } from "../src/knowledge-scope-lock.js";
import { KnowledgeScopeMountSchema, materializeKnowledgeScopePack } from "../src/knowledge-scope-mount.js";
import { KnowledgeScopeDefinitionSchema, QueryCapabilitySchema } from "../src/knowledge-scope.js";

const loadFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../fixtures/knowledge-scope/${name}`, import.meta.url), "utf8"));

describe("Knowledge Scope v0.1 split contract", () => {
  it("rejects server-owned installation state from a portable definition", async () => {
    // Given a valid portable definition polluted with a mount
    const definition = KnowledgeScopeDefinitionSchema.parse(
      await loadFixture("valid-definition.json"),
    );
    const mount = await loadFixture("valid-mount.json");

    // When it crosses the strict authoring boundary
    const result = KnowledgeScopeDefinitionSchema.safeParse({ ...definition, installation: mount });

    // Then server-owned identity cannot enter the portable artifact
    expect(result.success).toBe(false);
  });

  it("keeps definition identity independent from mount revision", async () => {
    // Given one definition and two revisions of its server-owned mount
    const definition = KnowledgeScopeDefinitionSchema.parse(
      await loadFixture("valid-definition.json"),
    );
    const mount = KnowledgeScopeMountSchema.parse(await loadFixture("valid-mount.json"));

    // When both mounts are materialized as legacy compatibility views
    const digest = await digestKnowledgeScopeDefinition(definition);
    const first = materializeKnowledgeScopePack(definition, mount);
    const second = materializeKnowledgeScopePack(definition, { ...mount, revision: mount.revision + 1 });

    // Then the portable digest is stable while mount revision remains server-owned
    expect(digest).toBe(mount.definitionDigest);
    expect(first.installation.packDigest).toBe(second.installation.packDigest);
  });

  it("builds and verifies a deterministic definition-only lock", async () => {
    // Given a definition and exactly its portable JSON inventory
    const rawDefinition = await loadFixture("valid-definition.json");
    const definition = KnowledgeScopeDefinitionSchema.parse(rawDefinition);
    const schemas = await loadFixture("schema-files.json");
    if (schemas === null || typeof schemas !== "object" || Array.isArray(schemas)) {
      throw new TypeError("schema-files.json must contain an object");
    }
    const files = { "scope.json": rawDefinition, ...schemas };

    // When the lock is built twice and verified
    const first = await buildKnowledgeScopeLock(definition, files);
    const second = await buildKnowledgeScopeLock(definition, files);
    const verified = await verifyKnowledgeScopeLock(definition, files, first);

    // Then inventory order and both digests are reproducible
    expect(first).toEqual(second);
    expect(first.files.map((entry) => entry.path)).toEqual(
      [...first.files.map((entry) => entry.path)].sort(),
    );
    expect(verified).toBe(true);
  });

  it("rejects extra portable files and a tampered lock digest", async () => {
    // Given the exact inventory, an undeclared file, and a valid lock
    const raw = await loadFixture("valid-definition.json");
    const definition = KnowledgeScopeDefinitionSchema.parse(raw);
    const schemas = await loadFixture("schema-files.json");
    if (schemas === null || typeof schemas !== "object" || Array.isArray(schemas)) {
      throw new TypeError("schema-files.json must contain an object");
    }
    const files = { "scope.json": raw, ...schemas };
    const lock = await buildKnowledgeScopeLock(definition, files);

    // When inventory or lock identity is changed
    let extraRejected = false;
    try {
      await buildKnowledgeScopeLock(definition, { ...files, "schema/extra.json": {} });
    } catch (error) {
      if (!(error instanceof KnowledgeScopeLockError)) throw error;
      extraRejected = true;
    }
    const verified = await verifyKnowledgeScopeLock(definition, files, { ...lock,
      lockDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" });

    // Then neither can be trusted
    expect(extraRejected).toBe(true);
    expect(verified).toBe(false);
  });

  it("rejects non-normalized schema and lock path components", async () => {
    // Given a valid capability, lock, and component-level path attacks
    const raw = await loadFixture("valid-definition.json");
    const definition = KnowledgeScopeDefinitionSchema.parse(raw);
    const schemas = await loadFixture("schema-files.json");
    if (schemas === null || typeof schemas !== "object" || Array.isArray(schemas)) {
      throw new TypeError("schema-files.json must contain an object");
    }
    const lock = await buildKnowledgeScopeLock(definition, { "scope.json": raw, ...schemas });
    const capability = definition.capabilities[0];
    if (capability === undefined) throw new TypeError("definition requires one capability");
    const paths = ["./schema.json", "a//b.json", "a/", "a/../b.json"];

    // When each path crosses both portable boundaries
    const capabilityResults = paths.map((path) => QueryCapabilitySchema.safeParse({
      ...capability, inputSchemaRef: path,
    }));
    const lockResults = paths.map((path) => KnowledgeScopeLockSchema.safeParse({
      ...lock, files: [{ ...lock.files[0], path }, ...lock.files.slice(1)],
    }));

    // Then no ambiguous or traversing component is accepted
    expect(capabilityResults.every((result) => !result.success)).toBe(true);
    expect(lockResults.every((result) => !result.success)).toBe(true);
  });

  it("locks only recursively portable safe-integer JSON numbers", async () => {
    // Given one definition and schema inventories containing fractional, unsafe, and integral numbers
    const raw = await loadFixture("valid-definition.json");
    const definition = KnowledgeScopeDefinitionSchema.parse(raw);
    const schemas = await loadFixture("schema-files.json");
    if (schemas === null || typeof schemas !== "object" || Array.isArray(schemas)) {
      throw new TypeError("schema-files.json must contain an object");
    }
    const base = { "scope.json": raw, ...schemas };
    const fractional = { ...base, "schema/search.input.json": { type: "number", minimum: 0.5 } };
    const unsafe = { ...base, "schema/search.input.json": { type: "integer", const: 9_007_199_254_740_992 } };
    const integral = { ...base, "schema/search.input.json": { type: "integer", const: 1e0 } };

    // When each inventory is locked
    const rejected = await Promise.allSettled([
      buildKnowledgeScopeLock(definition, fractional),
      buildKnowledgeScopeLock(definition, unsafe),
    ]);
    const accepted = await buildKnowledgeScopeLock(definition, integral);

    // Then ambiguous numeric encodings fail while an integral exponent normalizes to one
    expect(rejected.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(accepted.files.some((file) => file.path === "schema/search.input.json")).toBe(true);
  });

  it("orders canonical object keys by UTF-16 code units across languages", async () => {
    // Given BMP private-use and astral-plane keys whose code-point and UTF-16 orders differ
    const fixture = BoundedJsonValueSchema.parse(await loadFixture("canonical-unicode-order.json"));
    const digests = await loadFixture("conformance-digest.json");
    if (digests === null || typeof digests !== "object" || Array.isArray(digests)) {
      throw new TypeError("conformance-digest.json must contain an object");
    }

    // When the shared fixture is canonicalized and digested
    const canonical = canonicalJson(fixture);
    const digest = await digestCanonicalJson(fixture);

    // Then the astral surrogate pair sorts before U+E000 in the frozen UTF-16 contract
    expect(canonical).toBe('{"𐀀":"astral-plane","":"bmp-private-use"}');
    expect(digest).toBe(digests["canonical-unicode-order.json"]);
  });

  it("freezes JSON.stringify number semantics for cross-language candidates", async () => {
    // Given shared negative-zero, exponent-threshold, and shortest-round-trip values
    const fixture = z.record(z.number().finite()).parse(await loadFixture("canonical-number-parity.json"));
    const digests = await loadFixture("conformance-digest.json");
    if (digests === null || typeof digests !== "object" || Array.isArray(digests)) {
      throw new TypeError("conformance-digest.json must contain an object");
    }

    // When JavaScript canonical number serialization is applied
    const canonical = canonicalJson(fixture);
    const digest = await digestCanonicalJson(fixture);

    // Then the exact threshold and shortest forms remain portable
    expect(canonical).toBe('{"binarySum":0.30000000000000004,"integralFloat":1,"largeDecimalThreshold":100000000000000000000,"largeScientific":1e+21,"negativeZero":0,"shortestRoundTrip":1.2345678901234567,"smallDecimalThreshold":0.000001,"smallScientific":1e-7}');
    expect(digest).toBe(digests["canonical-number-parity.json"]);
  });
});
