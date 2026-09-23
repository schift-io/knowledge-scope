import { afterAll, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseOutput, requireObject, type CliResult } from "./fixtures/cli-e2e-harness.js";

const binary = resolve(import.meta.dir, "../dist/main.js");
const temporaryRoots: string[] = [];
afterAll(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "ks-easy-flow-"));
  temporaryRoots.push(root);
  const source = join(root, "고객 안내");
  await mkdir(source);
  await writeFile(join(source, "환불.md"), "# 환불 규정\n환불은 구매 후 14일 이내 가능합니다.\n배송은 영업일 3일 걸립니다.\n");
  const run = async (args: readonly string[]): Promise<CliResult> => {
    const child = Bun.spawn(["node", binary, ...args], {
      cwd: root,
      env: { ...process.env, SCHIFT_KS_HOME: join(root, "private-state") },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  };
  return { root, source, run };
};

it("connects selected notes and answers follow-ups in fresh processes without copying IDs", async () => {
  // Given: a new application directory with approved Korean notes.
  const project = await workspace();
  // When: the reader connects once and asks two questions using only ordinary words.
  const connected = await project.run(["connect", project.source]);
  const first = await project.run(["ask", "환불", "--json"]);
  const followUp = await project.run(["ask", "배송", "--json"]);
  // Then: separate processes resolve the same project and return real citations.
  expect(connected.exitCode, connected.stderr || connected.stdout).toBe(0);
  expect(connected.stdout).not.toContain('"installationId"');
  for (const result of [first, followUp]) {
    expect(result.exitCode).toBe(0);
    expect(parseOutput(result)).toMatchObject({ status: "ready" });
    expect(result.stdout).toContain("schift://local-documents/");
    expect(result.stdout).toContain("환불.md");
  }
}, 30_000);

it("refreshes the same project after an edit without another destination or ID", async () => {
  // Given: an already selected project whose source has changed.
  const project = await workspace();
  expect((await project.run(["connect", project.source])).exitCode).toBe(0);
  await writeFile(join(project.source, "환불.md"), "환불은 구매 후 30일 이내 가능합니다.\n");
  const beforeRefresh = await project.run(["ask", "환불", "--json"]);
  // When: the reader asks to refresh the currently selected project.
  const refreshed = await project.run(["refresh"]);
  const current = await project.run(["ask", "환불", "--json"]);
  // Then: the old snapshot is explicit until refresh, and the same ask command sees new evidence.
  expect(beforeRefresh.stdout).toContain("14일");
  expect(refreshed.exitCode).toBe(0);
  expect(current.exitCode).toBe(0);
  expect(current.stdout).toContain("30일");
  expect(current.stdout).not.toContain("14일");
}, 30_000);

it("preserves the usable project when its selected source cannot be refreshed", async () => {
  // Given: a valid project with source content that no longer meets import requirements.
  const project = await workspace();
  expect((await project.run(["connect", project.source])).exitCode).toBe(0);
  await writeFile(join(project.source, "환불.md"), "");
  // When: refresh fails and the reader asks again.
  const refreshed = await project.run(["refresh", "--json"]);
  const retained = await project.run(["ask", "환불", "--json"]);
  // Then: no successful replacement is claimed, and the previous snapshot remains available.
  expect(refreshed.exitCode).toBe(1);
  expect(retained.exitCode).toBe(0);
  expect(retained.stdout).toContain("14일");
}, 30_000);

it("keeps explicitly named projects separate instead of selecting the most recent one", async () => {
  // Given: two projects with different refund policies in the same application directory.
  const project = await workspace();
  const otherSource = join(project.root, "other.txt");
  await writeFile(otherSource, "환불은 구매 후 60일 이내 가능합니다.\n");
  expect((await project.run(["connect", project.source])).exitCode).toBe(0);
  expect((await project.run(["connect", otherSource, "--project", "other-project"])).exitCode).toBe(0);
  // When: both default and explicitly selected project are queried.
  const first = await project.run(["ask", "환불", "--json"]);
  const second = await project.run(["ask", "환불", "--project", "other-project", "--json"]);
  // Then: the default is not silently replaced by the last connected project.
  expect(first.stdout).toContain("14일");
  expect(first.stdout).not.toContain("60일");
  expect(second.stdout).toContain("60일");
  expect(second.stdout).not.toContain("14일");
}, 30_000);

it("does not import nearby notes or alter app dependencies when no project was selected", async () => {
  // Given: an application with notes but no knowledge connection.
  const project = await workspace();
  const manifest = '{"name":"customer-app","private":true}\n';
  await writeFile(join(project.root, "package.json"), manifest);
  // When: the reader asks without connecting a source.
  const output = await project.run(["ask", "환불", "--json"]);
  // Then: it fails closed and leaves the application manifest untouched.
  expect(output.exitCode).toBe(1);
  expect(output.stdout).not.toContain("14일");
  expect(await readFile(join(project.root, "package.json"), "utf8")).toBe(manifest);
}, 30_000);

it("returns no invented evidence for a question absent from the selected notes", async () => {
  // Given: notes contain a refund policy, but nothing about space travel.
  const project = await workspace();
  expect((await project.run(["connect", project.source])).exitCode).toBe(0);
  // When: the reader asks an unsupported question.
  const result = await project.run(["ask", "우주비행사", "--json"]);
  // Then: machine consumers can distinguish missing evidence from successful retrieval.
  expect(result.exitCode).toBe(0);
  expect(requireObject(parseOutput(result))).toMatchObject({ status: "insufficient_evidence", candidates: [] });
}, 30_000);
