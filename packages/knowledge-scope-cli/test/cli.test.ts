import { describe, expect, it } from "bun:test";
import { cp, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runKnowledgeScopeCli, type CliDependencies, type CliStreams } from "../src/cli.js";
import { DEFAULT_MAX_JSON_BYTES, parseJsonText, type JsonObject, type JsonValue } from "../src/json.js";
import { createCliDependencies } from "../src/main.js";

const dependencies = (): CliDependencies => ({
  authoring: {
    validate: async () => ({ status: "valid" }),
    lock: async () => ({ status: "locked" }),
    mountPayload: async () => ({ definition: {}, files: {}, lock: {}, scopeAuthority: {}, sourceBindings: [] }),
  },
  embedded: {
    mount: async () => ({ installationId: "installation-test" }),
    inspect: async () => ({ installationId: "installation-test" }),
    run: async () => ({ candidates: [] }),
    admit: async () => ({ status: "accepted" }),
    unmount: async () => ({ state: "unmounted" }),
  },
  remote: () => { throw new Error("unexpected remote client"); },
  serve: async () => ({ host: "127.0.0.1", port: 8787 }),
  readJson: async () => ({}),
});

const capture = (): { readonly streams: CliStreams; readonly stdout: string[]; readonly stderr: string[] } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, streams: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } };
};
const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

describe("schift-ks CLI", () => {
  it("writes a credential-free portable definition when init is requested", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "schift-ks-cli-"));
    const directory = join(root, "support-scope");
    const output = capture();

    // When
    const exitCode = await runKnowledgeScopeCli(["init", directory], dependencies(), output.streams);

    // Then
    expect(exitCode).toBe(0);
    const parsed: unknown = JSON.parse(await readFile(join(directory, "scope.json"), "utf8"));
    expect(parsed).toMatchObject({ packId: "support-scope", capabilities: [] });
    expect(JSON.stringify(parsed)).not.toContain("credential");
    expect(JSON.stringify(parsed)).not.toContain("binding");
    expect(JSON.parse(output.stdout[0] ?? "null")).toEqual({ directory, status: "initialized" });
  });

  it("accepts an unlocked definition but rejects a tampered existing lock", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "schift-ks-validate-"));
    const scope = join(root, "scope");
    const deps = createCliDependencies({ home: join(root, "state") });
    await runKnowledgeScopeCli(["init", scope], deps, capture().streams);
    const unlockedOutput = capture();

    // When
    const unlockedExit = await runKnowledgeScopeCli(["validate", scope], deps, unlockedOutput.streams);
    await runKnowledgeScopeCli(["lock", scope], deps, capture().streams);
    const definition = parseJsonText(await readFile(join(scope, "scope.json"), "utf8"), "scope.json");
    if (!isJsonObject(definition)) throw new TypeError("Definition is malformed");
    await writeFile(join(scope, "scope.json"), JSON.stringify({ ...definition, responsibility: "tampered-context" }));
    const tamperedOutput = capture();
    const tamperedExit = await runKnowledgeScopeCli(["validate", scope], deps, tamperedOutput.streams);

    // Then
    expect(unlockedExit).toBe(0);
    expect(JSON.parse(unlockedOutput.stdout[0] ?? "null")).toMatchObject({ lockVerified: false, status: "valid" });
    expect(tamperedExit).toBe(1);
    expect(JSON.parse(tamperedOutput.stderr[0] ?? "null")).toEqual({ code: "lock_invalid", status: "error" });
  });

  it("uses the remote wire when api-url is supplied", async () => {
    // Given
    const calls: string[] = [];
    const deps = dependencies();
    const remote = { ...deps.embedded, inspect: async (installationId: string): Promise<JsonValue> => {
      calls.push(installationId);
      return { installationId };
    } };
    const output = capture();

    // When
    const exitCode = await runKnowledgeScopeCli(
      ["inspect", "installation-remote", "--api-url", "http://127.0.0.1:8787"],
      { ...deps, remote: () => remote },
      output.streams,
    );

    // Then
    expect(exitCode).toBe(0);
    expect(calls).toEqual(["installation-remote"]);
  });

  it("writes redacted JSON errors to stderr and returns nonzero", async () => {
    // Given
    const secret = "do-not-print";
    const deps = dependencies();
    const output = capture();

    // When
    const exitCode = await runKnowledgeScopeCli(
      ["inspect", "installation-missing"],
      { ...deps, embedded: { ...deps.embedded, inspect: async () => { throw new Error(secret); } } },
      output.streams,
    );

    // Then
    expect(exitCode).toBe(1);
    expect(output.stderr).toHaveLength(1);
    expect(output.stderr[0]).not.toContain(secret);
    expect(JSON.parse(output.stderr[0] ?? "null")).toEqual({ code: "internal_error", status: "error" });
  });

  it("lists every supported command in help", async () => {
    // Given
    const output = capture();

    // When
    const exitCode = await runKnowledgeScopeCli(["--help"], dependencies(), output.streams);

    // Then
    expect(exitCode).toBe(0);
    for (const command of ["init", "validate", "lock", "mount", "inspect", "run", "admit", "unmount", "serve"]) {
      expect(output.stdout[0]).toContain(command);
    }
    expect(JSON.parse(output.stdout[0] ?? "null")).toMatchObject({
      serve: { apiTokenEnvironment: "SCHIFT_KS_API_TOKEN", loopbackOnly: true, tokenRequired: true },
    });
  });

  it("rejects the removed non-loopback serving flag", async () => {
    // Given
    const output = capture();

    // When
    const exitCode = await runKnowledgeScopeCli(["serve", "--allow-non-loopback"], dependencies(), output.streams);

    // Then
    expect(exitCode).toBe(1);
    expect(JSON.parse(output.stderr[0] ?? "null")).toEqual({ code: "argument_invalid", status: "error" });
  });

  it("rejects candidate batches over the application ceiling before admission", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "schift-ks-candidates-"));
    const path = join(root, "candidates.json");
    await writeFile(path, JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ index }))));
    let calls = 0;
    const deps = dependencies();
    const output = capture();

    // When
    const exitCode = await runKnowledgeScopeCli(
      ["admit", "installation-test", "--candidate", path],
      {
        ...deps,
        embedded: { ...deps.embedded, admit: async () => { calls += 1; return {}; } },
        readJson: async (file) => parseJsonText(await readFile(file, "utf8"), file),
      },
      output.streams,
    );

    // Then
    expect(exitCode).toBe(1);
    expect(calls).toBe(0);
    expect(JSON.parse(output.stderr[0] ?? "null")).toEqual({ code: "input_invalid", status: "error" });
  });

  it("rejects oversized and symlinked CLI JSON inputs before reading or dispatch", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "schift-ks-json-boundary-"));
    const scope = join(root, "scope");
    const deps = createCliDependencies({ home: join(root, "state") });
    await runKnowledgeScopeCli(["init", scope], deps, capture().streams);
    await runKnowledgeScopeCli(["lock", scope], deps, capture().streams);
    const oversized = join(root, "oversized.json");
    const target = join(root, "candidate.json");
    const linked = join(root, "candidate-link.json");
    await writeFile(oversized, JSON.stringify({ value: "x".repeat(DEFAULT_MAX_JSON_BYTES) }));
    await writeFile(target, "{}");
    await symlink(target, linked);

    // When
    const inputOutput = capture();
    const candidateOutput = capture();
    const bindingOutput = capture();
    const symlinkOutput = capture();
    const inputExit = await runKnowledgeScopeCli(["run", "installation", "operation", "--input", oversized], deps, inputOutput.streams);
    const candidateExit = await runKnowledgeScopeCli(["admit", "installation", "--candidate", oversized], deps, candidateOutput.streams);
    const bindingExit = await runKnowledgeScopeCli(["mount", scope, "--bindings", oversized], deps, bindingOutput.streams);
    const symlinkExit = await runKnowledgeScopeCli(["admit", "installation", "--candidate", linked], deps, symlinkOutput.streams);

    // Then
    expect([inputExit, candidateExit, bindingExit, symlinkExit]).toEqual([1, 1, 1, 1]);
    expect([inputOutput, candidateOutput, bindingOutput].map((output) => JSON.parse(output.stderr[0] ?? "null")))
      .toEqual(Array.from({ length: 3 }, () => ({ code: "json_limits_exceeded", status: "error" })));
    expect(JSON.parse(symlinkOutput.stderr[0] ?? "null")).toEqual({ code: "path_invalid", status: "error" });
  });

  it("completes lock, mount, run, inspect, and unmount with the real local application", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "schift-ks-lifecycle-"));
    const scope = join(root, "scope");
    const bindings = join(root, "bindings.json");
    const input = join(root, "input.json");
    await cp(new URL("../examples/support-scope", import.meta.url), scope, { recursive: true });
    await cp(new URL("../examples/mount-bindings.json", import.meta.url), bindings);
    await writeFile(input, JSON.stringify({ effectiveScope: { tenant: "replace-with-tenant" }, input: { query: "refund" } }));
    const deps = createCliDependencies({
      home: join(root, "state"),
      provider: { execute: async (context) => [{
        resultId: "result-1",
        revision: "revision-1",
        freshness: new Date().toISOString(),
        payload: { text: "Refunds require approval." },
        citation: { uri: "https://example.invalid/refunds" },
        providerScopes: context.capability.requiredProviderScopes ?? [],
        providerEvidence: context.capability.provider,
      }] },
    });

    // When
    const lockOutput = capture();
    const mountOutput = capture();
    expect(await runKnowledgeScopeCli(["lock", scope], deps, lockOutput.streams)).toBe(0);
    expect(await runKnowledgeScopeCli(["mount", scope, "--bindings", bindings], deps, mountOutput.streams)).toBe(0);
    const mounted = parseJsonText(mountOutput.stdout[0] ?? "null", "mount output");
    if (!isJsonObject(mounted) ||
      typeof mounted["installationId"] !== "string" || typeof mounted["revision"] !== "number") {
      throw new TypeError("Mount output is malformed");
    }
    const runOutput = capture();
    const inspectOutput = capture();
    const admitOutput = capture();
    const unmountOutput = capture();
    const runExit = await runKnowledgeScopeCli(["run", mounted["installationId"], "search-handbook", "--input", input], deps, runOutput.streams);
    const inspectExit = await runKnowledgeScopeCli(["inspect", mounted["installationId"]], deps, inspectOutput.streams);
    const runResult = parseJsonText(runOutput.stdout[0] ?? "null", "run output");
    if (!isJsonObject(runResult) || !Array.isArray(runResult["candidates"])) throw new TypeError("Run output is malformed");
    const candidatesPath = join(root, "candidates.json");
    await writeFile(candidatesPath, JSON.stringify(runResult["candidates"]));
    const admitExit = await runKnowledgeScopeCli(["admit", mounted["installationId"], "--candidate", candidatesPath], deps, admitOutput.streams);
    const unmountExit = await runKnowledgeScopeCli(["unmount", mounted["installationId"], "--expected-revision", String(mounted["revision"])], deps, unmountOutput.streams);

    // Then
    expect([runExit, inspectExit, admitExit, unmountExit]).toEqual([0, 0, 0, 0]);
    expect(JSON.parse(runOutput.stdout[0] ?? "null")).toMatchObject({ receipt: { status: "ready" } });
    expect(JSON.parse(admitOutput.stdout[0] ?? "null")).toMatchObject({ status: "ready" });
    expect(JSON.parse(inspectOutput.stdout[0] ?? "null")).toMatchObject({ mount: { state: "mounted" } });
    expect(JSON.parse(unmountOutput.stdout[0] ?? "null")).toMatchObject({ state: "unmounted" });
  });
});
