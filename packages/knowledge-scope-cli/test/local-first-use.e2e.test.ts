import { expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDependencies } from "../src/main.js";
import { createKnowledgeScopeClient } from "../src/client.js";
import { parseOutput, requireObject, runCli } from "./fixtures/cli-e2e-harness.js";

it("retrieves a user's text with citations and reuses it through a restarted SDK without accounts", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "ks-first-use-"));
  const source = join(root, "refund.md");
  const directory = join(root, "project");
  const home = join(root, "state");
  const environment = { SCHIFT_KS_HOME: home };
  await writeFile(source, "# Refund policy\nRefunds are available within fourteen days.\n환불은 구매 후 14일 이내에 가능합니다.\n");
  // When
  const started = await runCli(["quickstart", directory, "--source", source, "--query", "환불"], environment);
  // Then
  expect(started.exitCode).toBe(0);
  const output = requireObject(parseOutput(started));
  expect(output).toMatchObject({ status: "completed", result: { status: "ready" } });
  const id = output["installationId"];
  if (typeof id !== "string") throw new TypeError("Missing installation ID");
  const result = await createKnowledgeScopeClient({ application: createCliDependencies({ home, environment: {} }).embedded }).run({
    installationId: id, operationId: "search", effectiveScope: { tenant: "local-tenant" }, input: { query: "refund" },
  });
  expect(result.status).toBe("ready");
  expect(result.candidates.length).toBeGreaterThan(0);
  expect(result.candidates[0]?.citation?.uri).toStartWith("schift://local-documents/");
  expect(result.candidates[0]?.citation?.label).toContain("refund.md");
  expect(result.candidates[0]?.citation?.uri).toMatch(/#L\d+/);
  const definition = await readFile(join(directory, "pack/scope.json"), "utf8");
  expect(definition).toContain("local_documents");
  expect(definition).not.toContain(source);
  expect(definition).not.toContain("fourteen days");
}, 30_000);

it("repeats a query, reports insufficient evidence, and probes the local source without credentials", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "ks-query-local-"));
  const source = join(root, "shipping.txt");
  const environment = { SCHIFT_KS_HOME: join(root, "state") };
  await writeFile(source, "Shipping delivery takes three days.\n");
  const started = await runCli(["quickstart", join(root, "project"), "--source", source, "--query", "shipping"], environment);
  expect(started.exitCode).toBe(0);
  const id = requireObject(parseOutput(started))["installationId"];
  if (typeof id !== "string") throw new TypeError("Missing installation ID");
  // When
  const found = await runCli(["query", id, "--query", "delivery"], environment);
  const empty = await runCli(["query", id, "--query", "astronaut"], environment);
  const probe = await runCli(["doctor", id, "--probe", "--query", "shipping"], environment);
  // Then
  expect(found.exitCode).toBe(0);
  expect(parseOutput(found)).toMatchObject({ status: "ready" });
  expect(parseOutput(empty)).toMatchObject({ status: "insufficient_evidence", candidates: [] });
  expect(probe.exitCode).toBe(0);
  expect(parseOutput(probe)).toMatchObject({ status: "probed", result: { status: "ready" } });
}, 30_000);
