import { expect, it } from "bun:test";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseOutput, requireObject, runCli, startProviderServer, SENTINEL_TOKEN } from "./fixtures/cli-e2e-harness.js";

it("installs a real Search-backed workspace through the subprocess CLI and recovers failures", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "ks-onboarding-e2e-"));
  const provider = startProviderServer();
  const environment = { SCHIFT_KS_HOME: join(root, "state"), SCHIFT_KS_SEARCH_URL: provider.baseUrl, SCHIFT_KS_SEARCH_TOKEN: SENTINEL_TOKEN, SCHIFT_KS_SEARCH_ORGANIZATION_ID: "acme-org" };
  const argv = (directory: string) => ["quickstart", directory, "--index", "support-handbook", "--tenant", "acme", "--query", "refund"];
  try {
    // When
    const missing = await runCli(argv(join(root, "missing")), { ...environment, SCHIFT_KS_SEARCH_TOKEN: "" });
    expect(missing.exitCode).toBe(1); await expect(access(join(root, "missing"))).rejects.toThrow();
    const started = await runCli(argv(join(root, "project")), environment);
    expect(started.exitCode).toBe(0);
    const output = requireObject(parseOutput(started)); const id = output["installationId"];
    if (typeof id !== "string") throw new TypeError("Missing installation");
    const requests = provider.requests.length;
    const checked = await runCli(["doctor", id], environment);
    expect(provider.requests.length).toBe(requests);
    const probed = await runCli(["doctor", id, "--probe", "--query", "refund"], environment);
    const repeated = await runCli(argv(join(root, "project")), environment);
    // Then
    expect(parseOutput(started)).toMatchObject({ status: "completed", result: { status: "ready" } });
    expect(parseOutput(checked)).toMatchObject({ status: "configured", evidenceVerified: false });
    expect(parseOutput(probed)).toMatchObject({ status: "probed", result: { status: "ready" } });
    expect(repeated.exitCode).toBe(1); expect(repeated.stderr).toContain("directory_exists");
    expect(started.stdout + checked.stdout + probed.stdout + repeated.stderr).not.toContain(SENTINEL_TOKEN);
    expect(await readFile(join(root, "project/input.json"), "utf8")).toContain("refund");
    provider.stop();
    const unavailable = await runCli(argv(join(root, "unavailable")), environment);
    expect(unavailable.exitCode).toBe(1); expect(unavailable.stderr).toContain('"artifactsComplete":true');
    expect(unavailable.stderr).toContain('"installationId"');
    await access(join(root, "unavailable/input.json"));
  } finally { provider.stop(); }
}, 30_000);

it("returns insufficient evidence rather than claiming a ready project for empty Search results", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "ks-onboarding-empty-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => Response.json(
    new URL(request.url).pathname.endsWith("/search/status")
      ? { status: "ready", operational_status: "ready", bucket_id: "empty-index", last_indexed_at: new Date().toISOString() }
      : { status: "ready", operational_status: "ready", bucket_id: "empty-index", query: "refund", results: [] },
  ) });
  try {
    // When
    const result = await runCli(["quickstart", join(root, "project"), "--index", "empty-index", "--tenant", "acme", "--query", "refund"], {
      SCHIFT_KS_HOME: join(root, "state"), SCHIFT_KS_SEARCH_URL: `http://127.0.0.1:${server.port}`, SCHIFT_KS_SEARCH_TOKEN: SENTINEL_TOKEN, SCHIFT_KS_SEARCH_ORGANIZATION_ID: "acme-org",
    });
    // Then
    expect(result.exitCode).toBe(0);
    expect(parseOutput(result)).toMatchObject({ status: "completed", result: { status: "insufficient_evidence", candidates: [] } });
  } finally { server.stop(true); }
});
