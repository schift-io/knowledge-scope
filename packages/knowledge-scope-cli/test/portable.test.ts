import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createPortableLock,
  loadPortableScope,
  verifyPortableLock,
} from "../src/portable.js";

const temporaryDirectories: string[] = [];

const definition = {
  packId: "support-pack",
  version: "1.0.0",
  responsibility: "support.answers",
  scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
  capabilities: [{
    operationId: "search.docs",
    provider: { kind: "schift_search", indexRef: "support-index" },
    inputSchemaRef: "schemas/input.json",
    resultSchemaRef: "schemas/result.json",
  }],
  contextPolicy: {
    mustConsider: [{ id: "support.docs", selector: { sourceIds: ["support-docs"] }, minEvidence: 1 }],
    mustNotUse: [{ id: "private.notes", selector: { sourceIds: ["private-notes"] } }],
  },
  authority: {
    precedence: ["primary"],
    allowed: ["read"],
    forbidden: ["send", "approve", "mutate_source", "workflow"],
  },
  evidence: {
    requireCitation: true,
    freshness: { defaultMaxAgeSeconds: 3600 },
    coverageAssertions: ["support.docs"],
  },
};

const createPortable = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "schift-ks-portable-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "schemas"));
  await writeFile(join(directory, "scope.json"), JSON.stringify(definition));
  await writeFile(join(directory, "schemas/input.json"), JSON.stringify({ type: "object", additionalProperties: false }));
  await writeFile(join(directory, "schemas/result.json"), JSON.stringify({ type: "object" }));
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("portable Knowledge Scope", () => {
  it("creates and verifies a deterministic definition-only lock", async () => {
    // Given
    const directory = await createPortable();

    // When
    const first = await createPortableLock(directory);
    const second = await createPortableLock(directory);

    // Then
    expect(second).toEqual(first);
    expect(await verifyPortableLock(directory)).toBe(true);
    expect(first.files.map((file) => file.path)).toEqual([
      "schemas/input.json",
      "schemas/result.json",
      "scope.json",
    ]);
  });

  it("rejects undeclared portable JSON files", async () => {
    // Given
    const directory = await createPortable();
    await writeFile(join(directory, "extra.json"), "{}");

    // When / Then
    await expect(loadPortableScope(directory)).rejects.toThrow("portable_file_extra");
  });

  it("rejects every symbolic link without following it", async () => {
    // Given
    const directory = await createPortable();
    await symlink(join(directory, "schemas/input.json"), join(directory, "alias.json"));

    // When / Then
    await expect(loadPortableScope(directory)).rejects.toThrow("path_invalid");
  });

  it("can explicitly regenerate a tampered lock without trusting it", async () => {
    // Given
    const directory = await createPortable();
    await createPortableLock(directory);
    await writeFile(join(directory, "scope.lock.json"), "{}");

    // When
    const regenerated = await createPortableLock(directory);

    // Then
    expect(regenerated.schemaVersion).toBe("knowledge-scope-lock.schift.dev/v0.1");
    expect(await verifyPortableLock(directory)).toBe(true);
  });

  for (const undeclaredFile of ["credentials.txt", "raw-document.pdf"] as const) {
    it(`rejects undeclared regular file ${undeclaredFile}`, async () => {
      // Given
      const directory = await createPortable();
      await writeFile(join(directory, undeclaredFile), "must not be portable");

      // When / Then
      await expect(loadPortableScope(directory)).rejects.toThrow("portable_file_extra");
    });
  }

  it("rejects an oversized declared schema from metadata before loading it", async () => {
    // Given
    const directory = await createPortable();
    await truncate(join(directory, "schemas/input.json"), 1_048_577);

    // When / Then
    await expect(loadPortableScope(directory)).rejects.toThrow("json_limits_exceeded");
  });
});
