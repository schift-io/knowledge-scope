import { expect, it } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKnowledgeScopeCli } from "../src/cli.js";
import { parseCliOptions } from "../src/cli-options.js";
import { createCliDependencies } from "../src/main.js";

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ks-easy-cli-")));
  const source = join(root, "refund.md");
  await writeFile(source, "Refund policy: returns are available within 14 days.\n");
  const deps = createCliDependencies({ home: join(root, "state"), environment: {} });
  const run = async (args: readonly string[]) => {
    const stdout: string[] = []; const stderr: string[] = [];
    const code = await runKnowledgeScopeCli(args, deps, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    return { code, out: stdout.join("\n"), err: stderr.join("\n") };
  };
  return { source, project: join(root, "my project"), run };
};

it("offers connect first when invoked without arguments", async () => {
  // Given
  const { run } = await fixture();
  // When
  const result = await run([]);
  // Then
  expect(result.code).toBe(0);
  expect(result.out).toContain("schift-ks connect");
  expect(result.out.startsWith("{")).toBe(false);
});

it("keeps machine-readable help available", async () => {
  // Given
  const { run } = await fixture();
  // When
  const result = await run(["help", "--json"]);
  // Then
  expect(JSON.parse(result.out)).toMatchObject({ commands: expect.arrayContaining(["connect", "ask", "refresh"]) });
});

for (const [command, args] of [
  ["connect", []], ["connect", ["notes", "extra"]], ["connect", ["notes", "--unknown"]],
  ["ask", ["refund", "--json", "--json"]], ["ask", ["refund", "--project"]],
  ["refresh", ["--project", "a", "--project", "b"]], ["refresh", ["extra"]],
] satisfies [string, string[]][]) {
  it(`rejects invalid arguments for ${command}: ${args.join(" ")}`, () => {
    // Given / When / Then
    expect(() => parseCliOptions(command, args)).toThrow();
  });
}

it("shows selected documents and the next command without an installation ID", async () => {
  // Given
  const { source, project, run } = await fixture();
  // When
  const result = await run(["connect", source, "--project", project]);
  // Then
  expect(result.code).toBe(0);
  expect(result.out).toContain(source);
  expect(result.out).toContain("Local copies");
  expect(result.out).toContain("schift-ks ask");
  expect(result.out).toContain(project);
  expect(result.out).not.toContain("installationId");
});

it("retrieves real citations as human-readable evidence when asking", async () => {
  // Given
  const { source, project, run } = await fixture();
  await run(["connect", source, "--project", project]);
  // When
  const result = await run(["ask", "refund", "--project", project]);
  // Then
  expect(result.code).toBe(0);
  expect(result.out).toContain("14 days");
  expect(result.out).toContain("refund.md:L");
  expect(result.out).toContain("not a generated answer");
});

it("preserves structured results when json is requested", async () => {
  // Given
  const { source, project, run } = await fixture();
  // When
  const result = await run(["connect", source, "--project", project, "--json"]);
  // Then
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ status: "connected", source, directory: project });
});

it("offers a connection instead of importing implicitly when no project exists", async () => {
  // Given
  const { project, run } = await fixture();
  // When
  const result = await run(["ask", "refund", "--project", project]);
  // Then
  expect(result.code).toBe(1);
  expect(result.err).toContain("schift-ks connect");
  expect(result.err).not.toContain("ENOENT");
});

it("refreshes the selected project without asking for new IDs", async () => {
  // Given
  const { source, project, run } = await fixture();
  await run(["connect", source, "--project", project]);
  await writeFile(source, "Refund policy: returns are available within 30 days.\n");
  // When
  const result = await run(["refresh", "--project", project]);
  // Then
  expect(result.code).toBe(0);
  expect(result.out).toContain("Updated:");
  expect(result.out).toContain("schift-ks ask");
  expect(result.out).not.toContain("installationId");
});

it("redacts internal errors in the human workflow", async () => {
  // Given
  const { source, project, run } = await fixture();
  await run(["connect", source, "--project", project]);
  const deps = createCliDependencies({ home: join(project, "unused"), environment: {} });
  const stderr: string[] = [];
  // When
  const code = await runKnowledgeScopeCli(["ask", "refund", "--project", project], {
    ...deps, embedded: { ...deps.embedded, inspect: async () => { throw new Error("SECRET failure detail"); } },
  }, { stdout: () => {}, stderr: (line) => stderr.push(line) });
  // Then
  expect(code).toBe(1);
  expect(stderr.join()).not.toContain("SECRET");
  expect(stderr.join()).toContain("internal_error");
});

it("retains complete citation URIs for machine consumers", async () => {
  // Given
  const { source, project, run } = await fixture();
  await run(["connect", source, "--project", project]);
  // When
  const result = await run(["ask", "refund", "--project", project, "--json"]);
  // Then
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ candidates: [expect.objectContaining({ citation: expect.objectContaining({ uri: expect.stringMatching(/^schift:\/\/local-documents\/.+\/doc:.+#L\d+-L\d+$/) }) })] });
});
