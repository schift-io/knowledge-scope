import { afterEach, expect, it } from "bun:test";
import { mkdtemp, writeFile, rm, symlink, readdir, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDocumentStore } from "../src/local-documents/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "ks-local-documents-")); roots.push(root);
  return { root, store: new LocalDocumentStore({ home: join(root, "state") }) };
};
it("captures a UTF-8 source in a private content-addressed snapshot", async () => {
  // Given
  const { root, store } = await setup(); const source = join(root, "guide.md");
  await writeFile(source, "# 환불 규정\nRefunds within 30 days.");
  // When
  const result = await store.ingest(source);
  // Then
  expect(result.documentCount).toBe(1); expect(result.chunkCount).toBe(1);
  expect(result.indexRef).toMatch(/^local:[a-f0-9]{64}$/);
  const files = await readdir(join(store.home, "local-documents"));
  expect(files).toHaveLength(1);
  expect(await readFile(join(store.home, "local-documents", files[0] ?? ""), "utf8")).toContain("환불");
});
it("rejects an explicitly selected symlink", async () => {
  // Given
  const { root, store } = await setup(); await writeFile(join(root, "guide.md"), "Refund policy");
  await symlink(join(root, "guide.md"), join(root, "link.md"));
  // When / Then
  await expect(store.ingest(join(root, "link.md"))).rejects.toThrow();
});
it("rejects unsupported formats and binary text", async () => {
  // Given
  const { root, store } = await setup(); await writeFile(join(root, "guide.pdf"), "pdf");
  await writeFile(join(root, "binary.txt"), Buffer.from([0xff, 0xfe, 0]));
  // When / Then
  await expect(store.ingest(join(root, "guide.pdf"))).rejects.toThrow("Markdown");
  await expect(store.ingest(join(root, "binary.txt"))).rejects.toThrow();
});
it("ignores hidden files, node_modules and unsupported directory entries", async () => {
  // Given
  const { root, store } = await setup(); const source = join(root, "docs");
  await mkdir(source); await mkdir(join(source, "node_modules"));
  await writeFile(join(source, "guide.md"), "Refunds within 30 days.");
  await writeFile(join(source, ".secret.txt"), "Private");
  await writeFile(join(source, "guide.pdf"), "unsupported");
  await writeFile(join(source, "node_modules", "guide.txt"), "Dependency");
  // When
  const result = await store.ingest(source);
  // Then
  expect(result.documentCount).toBe(1);
});
it("rejects files over the byte budget before reading all data", async () => {
  // Given
  const { root, store } = await setup(); const source = join(root, "large.md");
  await writeFile(source, "x".repeat(1_048_577));
  // When / Then
  await expect(store.ingest(source)).rejects.toThrow("limits");
});
it("rejects symlinks encountered in a selected directory", async () => {
  // Given
  const { root, store } = await setup(); const source = join(root, "docs"); await mkdir(source);
  await writeFile(join(root, "outside.md"), "outside"); await symlink(join(root, "outside.md"), join(source, "link.md"));
  // When / Then
  await expect(store.ingest(source)).rejects.toThrow();
});
