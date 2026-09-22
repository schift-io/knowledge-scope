import { expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDependencies } from "../src/main.js";
import { connectLocalProject, askLocalProject, refreshLocalProject } from "../src/local-project.js";

it("reuses a selected project and refreshes its source without asking for IDs", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "ks-project-"));
  const source = join(root, "notes.md"); const directory = join(root, "project");
  await writeFile(source, "Refunds within seven days.");
  const dependencies = createCliDependencies({ home: join(root, "state"), environment: {} });
  const connected = await connectLocalProject({ source, directory }, dependencies);
  // When
  const reused = await connectLocalProject({ source, directory }, dependencies);
  const answer = await askLocalProject({ directory, query: "Refunds" }, dependencies);
  await writeFile(source, "Refunds within thirty days.");
  const refreshed = await refreshLocalProject({ directory }, dependencies);
  const updated = await askLocalProject({ directory, query: "Refunds" }, dependencies);
  // Then
  expect(connected).toMatchObject({ status: "connected", reused: false });
  expect(reused).toMatchObject({ status: "connected", reused: true });
  expect(JSON.stringify(answer)).toContain("seven days");
  expect(refreshed).toMatchObject({ status: "refreshed" });
  expect(JSON.stringify(updated)).toContain("thirty days");
  expect(JSON.stringify(updated)).not.toContain("seven days");
});
