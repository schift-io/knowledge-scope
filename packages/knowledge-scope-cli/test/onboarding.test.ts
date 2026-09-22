import { describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDependencies } from "../src/main.js";
import { runKnowledgeScopeCli } from "../src/cli.js";
import { parseJsonText, type JsonValue, type JsonObject } from "../src/json.js";

const environment = { SCHIFT_KS_SEARCH_URL: "http://127.0.0.1:1", SCHIFT_KS_SEARCH_TOKEN: "secret-sentinel", SCHIFT_KS_SEARCH_ORGANIZATION_ID: "test-org" };
const capture = () => {
  const stdout: string[] = []; const stderr: string[] = [];
  return { stdout, stderr, streams: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
};
const isObject = (value: JsonValue): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const object = (value: JsonValue): JsonObject => {
  if (!isObject(value)) throw new TypeError("Expected object");
  return value;
};
const args = (directory: string) => ["quickstart", directory, "--index", "support-index", "--tenant", "test-tenant", "--query", "refund policy"];

describe("project onboarding", () => {
  it("rejects absent config before creating the destination", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-onboarding-")); const directory = join(root, "project"); const output = capture();
    // When
    const exit = await runKnowledgeScopeCli(args(directory), createCliDependencies({ home: join(root, "state"), environment: {} }), output.streams);
    // Then
    expect(exit).toBe(1); expect(output.stderr[0]).toContain("SCHIFT_KS_SEARCH_TOKEN");
    await expect(access(directory)).rejects.toThrow();
  });
  it("preserves complete artifacts on provider failure and rejects reuse without mutation", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-onboarding-")); const directory = join(root, "project"); const output = capture();
    const deps = createCliDependencies({ home: join(root, "state"), environment, provider: { execute: async () => { throw new Error("secret-sentinel"); } } });
    // When
    expect(await runKnowledgeScopeCli(args(directory), deps, output.streams)).toBe(1);
    const failure = object(parseJsonText(output.stderr[0] ?? "null", "output"));
    const installationId = failure["installationId"];
    if (typeof installationId !== "string") throw new TypeError("Missing installation id");
    const before = await readFile(join(directory, "installation.json"), "utf8");
    const repeat = capture(); const exit = await runKnowledgeScopeCli(args(directory), deps, repeat.streams);
    // Then
    expect(failure["artifactsComplete"]).toBe(true); expect(typeof failure["installationId"]).toBe("string");
    expect(failure["recovery"]).toEqual(["schift-ks", "run", installationId, "search", "--input", join(directory, "input.json")]);
    expect(output.stderr.join()).not.toContain("secret-sentinel"); expect(exit).toBe(1); expect(repeat.stderr[0]).toContain("directory_exists");
    expect(await readFile(join(directory, "installation.json"), "utf8")).toBe(before);
    expect((await readdir(join(directory, "pack"))).sort()).toEqual(["schemas", "scope.json", "scope.lock.json"]);
  });
  it("checks config without execution and probes only on request", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-onboarding-")); let calls = 0;
    const deps = createCliDependencies({ home: join(root, "state"), environment, provider: { execute: async () => { calls += 1; return []; } } });
    const output = capture();
    expect(await runKnowledgeScopeCli(args(join(root, "project")), deps, output.streams)).toBe(0);
    const result = object(parseJsonText(output.stdout[0] ?? "null", "output")); const id = result["installationId"];
    if (typeof id !== "string") throw new TypeError("Missing id");
    // When
    const config = capture(); const probe = capture();
    expect(await runKnowledgeScopeCli(["doctor", id], deps, config.streams)).toBe(0);
    expect(calls).toBe(1);
    expect(await runKnowledgeScopeCli(["doctor", id, "--probe", "--query", "refund"], deps, probe.streams)).toBe(0);
    // Then
    expect(calls).toBe(2); expect(JSON.parse(config.stdout[0] ?? "null")).toMatchObject({ status: "configured", integrity: true, evidenceVerified: false });
    expect(JSON.parse(probe.stdout[0] ?? "null")).toMatchObject({ status: "probed", result: { status: "insufficient_evidence" } });
  });
  it("rejects unknown, duplicate, incomplete and extra CLI arguments before side effects", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-onboarding-")); const deps = createCliDependencies({ home: join(root, "state"), environment });
    // When / Then
    for (const argv of [["serve", "--typo"], ["serve", "--port", "1", "--port", "2"], ["serve", "--host"], ["inspect", "one", "two"], ["doctor", "one", "--probe"], ["doctor", "one", "--query", "hello"]]) {
      const output = capture(); expect(await runKnowledgeScopeCli(argv, deps, output.streams)).toBe(1); expect(output.stderr[0]).toContain("argument_invalid");
    }
  });
  it("reports invalid configuration names without leaking values or calling a provider", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "ks-onboarding-")); let calls = 0;
    const deps = createCliDependencies({ home: join(root, "state"), environment, provider: { execute: async () => { calls += 1; return []; } } });
    const output = capture();
    await runKnowledgeScopeCli(args(join(root, "project")), deps, output.streams);
    const id = object(parseJsonText(output.stdout[0] ?? "null", "output"))["installationId"];
    if (typeof id !== "string") throw new TypeError("Missing id");
    // When
    const checked = capture();
    await runKnowledgeScopeCli(["doctor", id], { ...deps, environment: { ...environment, SCHIFT_KS_SEARCH_URL: "https://secret-sentinel:password@example.test", SCHIFT_KS_SEARCH_ORGANIZATION_ID: "different-org" } }, checked.streams);
    // Then
    expect(calls).toBe(1); expect(checked.stdout[0]).not.toContain("secret-sentinel");
    expect(JSON.parse(checked.stdout[0] ?? "null")).toMatchObject({ configured: false, status: "attention_required", environment: ["SCHIFT_KS_SEARCH_URL", "SCHIFT_KS_SEARCH_ORGANIZATION_ID"] });
  });
});
