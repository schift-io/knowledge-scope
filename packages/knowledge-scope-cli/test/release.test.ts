import { expect, test } from "bun:test";
import { resolve } from "node:path";

const inventoryModule = resolve(import.meta.dir, "../scripts/release-inventory.mjs");

test("rejects packed credentials, source files and traversal outside the release inventory", () => {
  // Given: paths from the npm artifact inventory, including unwanted publication files.
  const invalidPaths = [".env", "src/main.ts", "node_modules/zod/index.js", "examples/.env", "dist/../secret.js", "dist/token.json"];
  // When: the release inventory boundary checks each path.
  const probe = Bun.spawnSync(["node", "--input-type=module", "--eval", `
    import { validateReleaseInventory } from ${JSON.stringify(inventoryModule)};
    for (const path of ${JSON.stringify(invalidPaths)}) {
      try { validateReleaseInventory([path]); process.exit(1); }
      catch (error) { if (!(error instanceof Error)) throw error; }
    }
  `]);
  // Then: every unwanted file fails the release gate.
  expect(probe.exitCode).toBe(0);
});

test("accepts new public declarations, examples and documentation without pinning a file count", () => {
  // Given: supported files, including future SDK and eval modules.
  const paths = ["package.json", "README.md", "LICENSE", "dist/main.js", "dist/index.js", "dist/context-pack.js", "dist/types/client.d.ts", "examples/evaluation/golden.json", "examples/evaluation/README.md", "docs/PILOT.md"];
  // When: the release inventory validates the artifact.
  const probe = Bun.spawnSync(["node", "--input-type=module", "--eval", `
    import { validateReleaseInventory } from ${JSON.stringify(inventoryModule)};
    validateReleaseInventory(${JSON.stringify(paths)});
  `]);
  // Then: additions within the declared public inventory remain compatible.
  expect(probe.exitCode).toBe(0);
});
