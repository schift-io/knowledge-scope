import { createCliDependencies, createKnowledgeScopeClient } from "@schift-io/knowledge-scope";

const [installationId, tenant, query, operationId = "search"] = process.argv.slice(2);
if (!installationId || !tenant || !query) {
  process.stderr.write("Usage: node consumer.mjs <installation-id> <tenant> <question> [operation-id]\n");
  process.exitCode = 2;
} else {
  const client = createKnowledgeScopeClient({ application: createCliDependencies().embedded });
  try {
    const result = await client.run({ installationId, operationId, effectiveScope: { tenant }, input: { query } });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "insufficient_evidence") process.exitCode = 3;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", code: typeof error?.code === "string" ? error.code : "consumer_failed" })}\n`);
    process.exitCode = 1;
  }
}
