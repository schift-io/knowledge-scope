import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const readDeclarationTree = async (directory: string): Promise<string> => {
  const declarations: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) declarations.push(await readDeclarationTree(path));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) declarations.push(await readFile(path, "utf8"));
  }
  return declarations.join("\n");
};

const PackageManifestSchema = z.object({
  bin: z.object({ "schift-ks": z.string() }),
  dependencies: z.record(z.string()).optional(),
  devDependencies: z.record(z.string()).optional(),
  exports: z.object({
    ".": z.object({ import: z.string(), types: z.string() }),
    "./context-pack": z.object({ import: z.string(), types: z.string() }),
  }),
  main: z.string(),
  scripts: z.object({ build: z.string(), prepack: z.string() }),
  types: z.string(),
});

describe("published package", () => {
  test("locks release dependencies to registry integrity without workspace links", async () => {
    // Given: the package-local lock used for the isolated release build.
    const lock = z.object({ lockfileVersion: z.literal(3), packages: z.record(z.object({
      version: z.string().optional(), resolved: z.string().optional(), integrity: z.string().optional(),
      link: z.boolean().optional(),
    })) }).parse(JSON.parse(await readFile(join(packageRoot, "package-lock.json"), "utf8")));
    // When: dependency entries are separated from the root package.
    const dependencies = Object.entries(lock.packages).filter(([path]) => path !== "");
    // Then: fresh installations resolve only content-verified registry artifacts.
    expect(dependencies.length).toBeGreaterThan(0);
    for (const [path, dependency] of dependencies) {
      expect(path.startsWith("node_modules/")).toBeTrue();
      expect(dependency.link).not.toBeTrue();
      expect(dependency.resolved?.startsWith("https://registry.npmjs.org/")).toBeTrue();
      expect(dependency.integrity?.startsWith("sha512-")).toBeTrue();
    }
  });

  test("declares CLI and SDK entry points without workspace dependencies", async () => {
    // Given: the package manifest at the publication boundary.
    const manifest = PackageManifestSchema.parse(
      JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
    );

    // When: its runtime and development dependencies are combined.
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };

    // Then: consumers receive both supported entry points without workspace links.
    expect(manifest.bin["schift-ks"]).toBe("./dist/main.js");
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/types/index.d.ts");
    expect(manifest.exports["."].import).toBe("./dist/index.js");
    expect(manifest.exports["."].types).toBe("./dist/types/index.d.ts");
    expect(manifest.exports["./context-pack"].import).toBe("./dist/context-pack.js");
    expect(manifest.exports["./context-pack"].types).toBe("./dist/types/context-pack/index.d.ts");
    expect(Object.values(dependencies).some((version) => version.startsWith("workspace:"))).toBeFalse();
  });

  test("built package runs help in Node and exposes the public SDK", async () => {
    // Given: package artifacts produced by the package build.
    const entry = join(packageRoot, "dist", "index.js");
    const binary = join(packageRoot, "dist", "main.js");

    // When: Node executes the CLI and a consumer imports the SDK bundle.
    const help = Bun.spawnSync(["node", binary, "--help"]);
    const sdkProbe = Bun.spawnSync([
      "node",
      "--input-type=module",
      "--eval",
      [
        `import * as sdk from ${JSON.stringify(pathToFileURL(entry).href)};`,
        "process.stdout.write(JSON.stringify([",
        "typeof sdk.createCliDependencies,",
        "typeof sdk.KnowledgeScopeApplication,",
        "typeof sdk.createHttpProviderExecutionPort",
        "]));",
      ].join(""),
    ]);

    // Then: both entry points are independently usable.
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("schift-ks");
    expect(sdkProbe.exitCode).toBe(0);
    expect(sdkProbe.stdout.toString()).toBe('["function","function","function"]');
  });

  test("ships only Knowledge Scope declarations from the Context Pack contract", async () => {
    // Given: every declaration exposed by the built package.
    const declarationRoot = join(packageRoot, "dist", "types");
    const allDeclarations = await readDeclarationTree(declarationRoot);
    const contextDeclarations = await readDeclarationTree(join(declarationRoot, "context-pack"));

    // When: the declaration artifact is checked for adjacent product concepts.
    const unrelatedConcepts = ["AgentContext", "A2A", "APM", "Workflow", "context-csm"];

    // Then: no adjacent product declaration leaks into the Knowledge Scope tarball.
    for (const concept of unrelatedConcepts) expect(allDeclarations).not.toContain(concept);
    expect(contextDeclarations).not.toContain("Runtime");
  });

  test("bundles only the Knowledge Scope implementation boundary", async () => {
    // Given: both executable JavaScript entry points from the publication artifact.
    const runtimeBundle = ["context-pack.js", "index.js", "main.js"]
      .map((entry) => Bun.file(join(packageRoot, "dist", entry)).text());

    // When: the complete bundled source is inspected.
    const source = (await Promise.all(runtimeBundle)).join("\n");
    const unrelatedConcepts = [
      "AgentContext",
      "agent-context",
      "SearchUsage",
      "search-usage",
      "A2A",
      "context-csm",
      "APM",
      "Workflow",
      "RuntimeId",
      "ContextRuntime",
      "ContextPackRuntime",
    ];

    // Then: adjacent Context products are absent from the installed runtime.
    for (const concept of unrelatedConcepts) expect(source).not.toContain(concept);
  });

  test("exposes the Context Pack subpath as a working Node module", () => {
    // Given: the packaged example and Context Pack JavaScript entry point.
    const entry = pathToFileURL(join(packageRoot, "dist", "context-pack.js")).href;
    const fixture = join(packageRoot, "examples", "support-scope", "scope.json");

    // When: Node imports the subpath implementation and parses the real fixture.
    const probe = Bun.spawnSync([
      "node",
      "--input-type=module",
      "--eval",
      [
        'import { readFile } from "node:fs/promises";',
        `import { KnowledgeScopeDefinitionSchema, CapabilityBatchExecutionRequestSchema } from ${JSON.stringify(entry)};`,
        'CapabilityBatchExecutionRequestSchema.parse({ installationId: "ks-installed", effectiveScope: { tenant: "tenant.test" }, operations: [{ operationId: "search-handbook", input: { query: "evidence" } }] });',
        `const value = JSON.parse(await readFile(${JSON.stringify(fixture)}, "utf8"));`,
        "process.stdout.write(KnowledgeScopeDefinitionSchema.parse(value).packId);",
      ].join(""),
    ]);

    // Then: the runtime export matches its declaration contract.
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.toString()).toBe("support-scope");
  });
});
