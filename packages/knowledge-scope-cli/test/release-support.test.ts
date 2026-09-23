import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

it("declares an unpublished new candidate and the local runtime support boundary", async () => {
  // Given: the package consumers will install, not the monorepo manifest.
  const manifest = z.object({ version: z.string(), engines: z.object({ node: z.string() }), os: z.array(z.string()).optional() });
  // When: the release support declaration is read from its publication boundary.
  const value = manifest.parse(JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8")));
  // Then: the new implementation cannot accidentally reuse the already-published version or imply Windows support.
  expect(value.version).toBe("0.3.0");
  expect(value.engines.node).toBe("^22.0.0 || ^24.0.0");
  expect(value.os).toEqual(["darwin", "linux"]);
});
