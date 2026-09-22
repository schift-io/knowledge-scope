import { afterEach, expect, it } from "bun:test";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectFiles, readBounded, LocalDocumentError } from "../src/local-documents/files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
it("rejects an ancestor swapped to an outside directory between collection and reading", async () => {
  // Given: collect the genuine source first, then deterministically swap its ancestor.
  const root = await mkdtemp(join(tmpdir(), "ks-source-race-")); roots.push(root);
  await mkdir(join(root, "docs")); await mkdir(join(root, "outside"));
  await writeFile(join(root, "docs", "policy.md"), "INSIDE_SYNTHETIC");
  await writeFile(join(root, "outside", "policy.md"), "OUTSIDE_SYNTHETIC");
  const files = await collectFiles(join(root, "docs")); const file = files[0];
  if (file === undefined) throw new Error("fixture missing");
  await rename(join(root, "docs"), join(root, "original"));
  await symlink(join(root, "outside"), join(root, "docs"));
  // When / Then: no outside contents are returned.
  await expect(readBounded(file, 1024)).rejects.toBeInstanceOf(LocalDocumentError);
});
it("rejects a hardlinked source even when its extension is supported", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "ks-source-hardlink-")); roots.push(root);
  await writeFile(join(root, "outside.txt"), "outside");
  await link(join(root, "outside.txt"), join(root, "policy.md"));
  // When / Then
  await expect(collectFiles(join(root, "policy.md"))).rejects.toBeInstanceOf(LocalDocumentError);
});
it("rejects a different file inode installed after enumeration", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "ks-file-race-")); roots.push(root);
  const source = join(root, "policy.md"); await writeFile(source, "Original");
  const files = await collectFiles(source); const file = files[0];
  if (file === undefined) throw new Error("fixture missing");
  await rename(source, join(root, "original.md")); await writeFile(source, "Replaced");
  // When / Then
  await expect(readBounded(file, 1024)).rejects.toBeInstanceOf(LocalDocumentError);
});
it("maps a missing private snapshot to a stable redacted error", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "ks-snapshot-missing-")); roots.push(root);
  // When / Then
  await expect(readBounded(join(root, "missing.json"), 1024, true)).rejects.toMatchObject({ code: "local_snapshot_invalid" });
});
