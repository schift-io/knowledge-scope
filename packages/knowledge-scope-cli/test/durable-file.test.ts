import { expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeDurableFile, writeDurableNewFile } from "../src/durable-file.js";

it("preserves old contents and cleans temporary files when failure occurs before rename", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "ks-durable-")); const path = join(directory, "project.json");
  await writeFile(path, "previous", { mode: 0o600 });
  try {
    // When
    await expect(writeDurableFile(path, "next", { beforeRename: async () => { throw new Error("injected failure"); } })).rejects.toThrow("injected failure");
    // Then
    expect(await readFile(path, "utf8")).toBe("previous");
    expect(await readdir(directory)).toEqual(["project.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("refuses overwriting an existing durable new file", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "ks-durable-")); const path = join(directory, "scope.json");
  await writeFile(path, "previous", { mode: 0o600 });
  try {
    // When
    await expect(writeDurableNewFile(path, "next")).rejects.toMatchObject({ code: "EEXIST" });
    // Then
    expect(await readFile(path, "utf8")).toBe("previous");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("persists a newly created file with owner-only permissions", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "ks-durable-")); const path = join(directory, "scope.json");
  try {
    // When
    await writeDurableNewFile(path, "complete");
    // Then
    expect(await readFile(path, "utf8")).toBe("complete");
    expect((await stat(path)).mode & 0o077).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("reports failed new-file sync as uncertain and retains the visible file", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "ks-durable-")); const path = join(directory, "scope.json");
  try {
    // When
    await expect(writeDurableNewFile(path, "visible", { beforeSync: async () => { throw new Error("sync failed"); } })).rejects.toThrow("commit_uncertain");
    // Then
    expect(await readFile(path, "utf8")).toBe("visible");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("reports an uncertain commit after rename without deleting the new file", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "ks-durable-")); const path = join(directory, "project.json");
  await writeFile(path, "previous", { mode: 0o600 });
  try {
    // When
    await expect(writeDurableFile(path, "next", { afterRename: async () => { throw new Error("directory sync unavailable"); } })).rejects.toThrow("commit_uncertain");
    // Then
    expect(await readFile(path, "utf8")).toBe("next");
    expect(await readdir(directory)).toEqual(["project.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
