import { readFile } from "node:fs/promises";
import { createCliDependencies, createKnowledgeScopeClient } from "@schift-io/knowledge-scope";

const [installationId, requestPath] = process.argv.slice(2);
if (!installationId || !requestPath) {
  process.stderr.write("Usage: node batch-consumer.mjs <installation-id> <batch-request.json>\n");
  process.exitCode = 2;
} else {
  const client = createKnowledgeScopeClient({ application: createCliDependencies().embedded });
  try {
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const result = await client.runBatch({ ...request, installationId });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "insufficient_evidence") process.exitCode = 3;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", code: typeof error?.code === "string" ? error.code : "consumer_failed" })}\n`);
    process.exitCode = 1;
  }
}
