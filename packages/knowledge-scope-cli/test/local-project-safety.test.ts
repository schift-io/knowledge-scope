import { expect, it } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createCliDependencies } from "../src/main.js";
import { connectLocalProject, askLocalProject, refreshLocalProject } from "../src/local-project.js";
import { KnowledgeScopeApplication } from "../src/application.js";
import { KnowledgeScopeStateStore } from "../src/state-store.js";
import { KnowledgeScopeAuthorization } from "../src/authorization.js";
import { LocalDocumentStore } from "../src/local-documents/index.js";
import { parseJsonText } from "../src/json.js";
import { spawnSync } from "node:child_process";

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "ks-project-safety-")); const source = join(root, "notes.md");
  const home = join(root, "state"); const directory = join(root, "project");
  await writeFile(source, "Refunds within seven days.");
  const dependencies = createCliDependencies({ home, environment: {} });
  const connection = z.object({ installationId: z.string() }).parse(await connectLocalProject({ source, directory }, dependencies));
  return { root, source, home, directory, dependencies, connection };
};

it("keeps the selected snapshot when refresh fails", async () => {
  // Given
  const fixture = await setup(); await writeFile(fixture.source, "\u0000binary");
  const original = await readFile(join(fixture.directory, "project.json"), "utf8");
  // When
  await expect(refreshLocalProject(fixture, fixture.dependencies)).rejects.toThrow();
  // Then
  expect(await readFile(join(fixture.directory, "project.json"), "utf8")).toBe(original);
  expect(JSON.stringify(await askLocalProject({ directory: fixture.directory, query: "Refunds" }, fixture.dependencies))).toContain("seven days");
});

it("refuses a different source without replacing a selected project", async () => {
  // Given
  const fixture = await setup(); const source = join(fixture.root, "other.md"); await writeFile(source, "Private material");
  // When / Then
  await expect(connectLocalProject({ directory: fixture.directory, source }, fixture.dependencies)).rejects.toThrow("project_source_mismatch");
});

it("does not revive revoked access through refresh", async () => {
  // Given
  const fixture = await setup(); await fixture.dependencies.embedded.unmount({ installationId: fixture.connection.installationId, expectedRevision: 1 });
  // When / Then
  await expect(refreshLocalProject(fixture, fixture.dependencies)).rejects.toThrow("installation_mismatch");
  await expect(askLocalProject({ directory: fixture.directory, query: "Refunds" }, fixture.dependencies)).rejects.toThrow("installation_mismatch");
});

it("rejects a tampered source pointer before reading its data", async () => {
  // Given
  const fixture = await setup(); const path = join(fixture.directory, "project.json");
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace(fixture.source, join(fixture.root, "other.md")));
  // When / Then
  await expect(refreshLocalProject(fixture, fixture.dependencies)).rejects.toThrow("project_invalid");
});

for (const kind of ["symlink", "hardlink"] as const) {
  it(`rejects ${kind} project metadata`, async () => {
    // Given
    const fixture = await setup(); const path = join(fixture.directory, "project.json"); const moved = join(fixture.directory, "old.json");
    await rename(path, moved);
    if (kind === "symlink") await symlink(moved, path); else await link(moved, path);
    // When / Then
    await expect(askLocalProject({ directory: fixture.directory, query: "Refunds" }, fixture.dependencies)).rejects.toThrow("project_invalid");
  });
}

it("rejects a competing refresh while retaining its active lock", async () => {
  // Given
  const fixture = await setup(); await writeFile(join(fixture.directory, ".project.lock"), "pending", { mode: 0o600 });
  // When / Then
  await expect(refreshLocalProject(fixture, fixture.dependencies)).rejects.toThrow("project_busy");
  expect(await readFile(join(fixture.directory, ".project.lock"), "utf8")).toBe("pending");
});

it("withholds expired evidence and tells the caller to refresh", async () => {
  // Given
  const fixture = await setup();
  const application = new KnowledgeScopeApplication({ store: new KnowledgeScopeStateStore({ home: fixture.home }),
    authorization: new KnowledgeScopeAuthorization({ home: fixture.home }), provider: new LocalDocumentStore({ home: fixture.home }),
    now: () => new Date(Date.now() + 86_401_000) });
  const dependencies = { ...fixture.dependencies, embedded: { ...fixture.dependencies.embedded, run: async (request: Parameters<typeof fixture.dependencies.embedded.run>[0]) => parseJsonText(JSON.stringify(await application.run(request)), "test result") } };
  // When
  const result = await askLocalProject({ directory: fixture.directory, query: "Refunds" }, dependencies);
  // Then
  expect(result).toMatchObject({ status: "insufficient_evidence", candidates: [] });
  expect(JSON.stringify(result)).toContain("Evidence expired");
});

it("keeps distinct projects isolated", async () => {
  // Given
  const first = await setup(); const source = join(first.root, "second.md"); const directory = join(first.root, "second-project");
  await writeFile(source, "Refunds within thirty days."); await connectLocalProject({ directory, source }, first.dependencies);
  // When
  const result = await askLocalProject({ directory, query: "Refunds" }, first.dependencies);
  // Then
  expect(JSON.stringify(result)).toContain("thirty days"); expect(JSON.stringify(result)).not.toContain("seven days");
});

it("rejects project parent symlink hops", async () => {
  // Given
  const fixture = await setup(); const alias = join(fixture.root, "alias"); await symlink(fixture.directory, alias);
  // When / Then
  await expect(connectLocalProject({ directory: join(alias, "nested"), source: fixture.source }, fixture.dependencies)).rejects.toThrow("project_invalid");
});

it("preserves files in an existing unowned directory", async () => {
  // Given
  const fixture = await setup(); const directory = join(fixture.root, "occupied");
  await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, "keep.md"), "keep");
  // When / Then
  await expect(connectLocalProject({ directory, source: fixture.source }, fixture.dependencies)).rejects.toThrow("project_invalid");
  expect(await readFile(join(directory, "keep.md"), "utf8")).toBe("keep");
});

it("explains missing source without an internal error", async () => {
  // Given
  const fixture = await setup();
  // When / Then
  await expect(connectLocalProject({ directory: join(fixture.root, "new"), source: join(fixture.root, "missing.md") }, fixture.dependencies)).rejects.toThrow("local_source_invalid");
});

it("refuses refresh when an approved source ancestor becomes a symlink", async () => {
  // Given
  const fixture = await setup(); const folder = join(fixture.root, "approved"); const moved = join(fixture.root, "moved");
  const replacement = join(fixture.root, "replacement"); const directory = join(fixture.root, "nested-project");
  await mkdir(folder); await mkdir(replacement);
  await writeFile(join(folder, "notes.md"), "Refunds within seven days.");
  await writeFile(join(replacement, "notes.md"), "Refunds within ninety days.");
  await connectLocalProject({ directory, source: join(folder, "notes.md") }, fixture.dependencies);
  await rename(folder, moved); await symlink(replacement, folder);
  // When / Then
  await expect(refreshLocalProject({ directory }, fixture.dependencies)).rejects.toThrow("project_invalid");
  expect(JSON.stringify(await askLocalProject({ directory, query: "Refunds" }, fixture.dependencies))).toContain("seven days");
});

it("keeps private project metadata out of ordinary Git adds", async () => {
  // Given
  const fixture = await setup();
  expect(spawnSync("git", ["init", "--quiet", fixture.root]).status).toBe(0);
  const project = z.object({ snapshot: z.string() }).parse(JSON.parse(await readFile(join(fixture.directory, "project.json"), "utf8")));
  // When
  const ignored = ["project/project.json", `project/${project.snapshot}/installation.json`].map((path) =>
    spawnSync("git", ["check-ignore", "--quiet", path], { cwd: fixture.root }).status);
  // Then
  expect(ignored).toEqual([0, 0]);
  expect(await readFile(join(fixture.directory, ".gitignore"), "utf8")).toBe("*\n");
});
