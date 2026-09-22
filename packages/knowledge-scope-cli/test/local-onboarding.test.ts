import { describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDependencies } from "../src/main.js";
import { runKnowledgeScopeCli } from "../src/cli.js";

const capture = () => {
  const stdout: string[] = []; const stderr: string[] = [];
  return { stdout, stderr, streams: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
};

describe("local first use", () => {
  it("creates a portable local project without hosted credentials", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-local-onboarding-")); const directory = join(root, "project"); const output = capture();
    const deps = { ...createCliDependencies({ home: join(root, "state"), environment: {}, provider: { execute: async () => [] } }),
      localDocuments: { ingest: async () => ({ indexRef: "local-index", documentCount: 1, chunkCount: 2 }) } };
    // When
    const exit = await runKnowledgeScopeCli(["quickstart", directory, "--source", "/private/example.md", "--query", "refund"], deps, output.streams);
    // Then
    expect(output.stderr).toEqual([]); expect(exit).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "null")).toMatchObject({ tenant: "local-tenant", documentCount: 1, chunkCount: 2, result: { status: "insufficient_evidence" } });
    const definition = await readFile(join(directory, "pack/scope.json"), "utf8");
    expect(definition).toContain("local_documents"); expect(definition).not.toContain("/private/example.md");
  });
  it("rejects ambiguous sources before import or workspace creation", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-local-onboarding-")); const directory = join(root, "project"); const output = capture(); let imports = 0;
    const deps = { ...createCliDependencies({ home: join(root, "state"), environment: {} }), localDocuments: { ingest: async () => { imports += 1; return { indexRef: "local-index", documentCount: 1, chunkCount: 1 }; } } };
    // When
    const exit = await runKnowledgeScopeCli(["quickstart", directory, "--source", "notes.md", "--index", "hosted", "--query", "refund"], deps, output.streams);
    // Then
    expect(exit).toBe(1); expect(imports).toBe(0); expect(output.stderr[0]).toContain("argument_invalid"); await expect(access(directory)).rejects.toThrow();
  });
  it("preserves an existing workspace without importing data", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-local-onboarding-")); const directory = join(root, "project"); const output = capture(); let imports = 0;
    await mkdir(directory); await writeFile(join(directory, "keep.txt"), "keep");
    const deps = { ...createCliDependencies({ home: join(root, "state"), environment: {} }), localDocuments: { ingest: async () => { imports += 1; return { indexRef: "local-index", documentCount: 1, chunkCount: 1 }; } } };
    // When
    const exit = await runKnowledgeScopeCli(["quickstart", directory, "--source", "notes.md", "--query", "refund"], deps, output.streams);
    // Then
    expect(exit).toBe(1); expect(imports).toBe(0); expect(output.stderr[0]).toContain("directory_exists"); expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("keep");
  });
  it("redacts failed imports and returns a safe retry", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-local-onboarding-")); const output = capture();
    const deps = { ...createCliDependencies({ home: join(root, "state"), environment: {} }), localDocuments: { ingest: async () => { throw new Error("private-source-sentinel"); } } };
    // When
    const exit = await runKnowledgeScopeCli(["quickstart", join(root, "project"), "--source", "notes.md", "--query", "refund"], deps, output.streams);
    // Then
    expect(exit).toBe(1); expect(output.stderr[0]).not.toContain("private-source-sentinel");
    expect(JSON.parse(output.stderr[0] ?? "null")).toMatchObject({ code: "local_quickstart_failed", artifactsComplete: false, recovery: ["schift-ks", "quickstart", "<new-workspace>", "--source", "<file-or-directory>", "--query", "<question>"] });
  });
  it("derives the follow-up query tenant from the mounted project", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-local-onboarding-")); const first = capture(); const output = capture();
    const deps = { ...createCliDependencies({ home: join(root, "state"), environment: {}, provider: { execute: async () => [] } }),
      localDocuments: { ingest: async () => ({ indexRef: "local-index", documentCount: 1, chunkCount: 1 }) } };
    expect(await runKnowledgeScopeCli(["quickstart", join(root, "project"), "--source", "notes.md", "--tenant", "customer-tenant", "--query", "refund"], deps, first.streams)).toBe(0);
    const parsed: unknown = JSON.parse(first.stdout[0] ?? "null");
    if (parsed === null || typeof parsed !== "object" || !("installationId" in parsed) || typeof parsed.installationId !== "string") throw new TypeError("Missing installation id");
    // When
    const exit = await runKnowledgeScopeCli(["query", parsed.installationId, "--query", "delivery"], deps, output.streams);
    // Then
    expect(exit).toBe(0); expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0] ?? "null")).toMatchObject({ status: "insufficient_evidence" });
  });
  it("rejects empty questions before touching a source", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-local-onboarding-")); const directory = join(root, "project"); const output = capture(); let imports = 0;
    const deps = { ...createCliDependencies({ home: join(root, "state"), environment: {} }), localDocuments: { ingest: async () => { imports += 1; return { indexRef: "local-index", documentCount: 1, chunkCount: 1 }; } } };
    // When
    const exit = await runKnowledgeScopeCli(["quickstart", directory, "--source", "notes.md", "--query", "   "], deps, output.streams);
    // Then
    expect(exit).toBe(1); expect(imports).toBe(0); expect(output.stderr[0]).toContain("argument_invalid"); await expect(access(directory)).rejects.toThrow();
  });
});
