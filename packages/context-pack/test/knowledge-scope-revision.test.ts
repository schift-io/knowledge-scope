import { expect, it } from "bun:test";
import { CapabilityExecutionRequestSchema } from "../src/knowledge-scope-execution.js";
import { CapabilityBatchExecutionRequestSchema } from "../src/knowledge-scope-batch.js";

const common = { installationId: "ks-parity", effectiveScope: { tenant: "tenant-parity" } };
const operation = { operationId: "search.docs", input: null };

it.each([null, true, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects a nonportable revision in both request shapes %#", (expectedRevision) => {
    // Given / When: both runtimes must agree on the numeric revision domain.
    const single = CapabilityExecutionRequestSchema.safeParse({ ...common, ...operation, expectedRevision });
    const batch = CapabilityBatchExecutionRequestSchema.safeParse({ ...common, operations: [operation], expectedRevision });
    // Then
    expect(single.success).toBe(false);
    expect(batch.success).toBe(false);
  },
);

it("accepts equivalent integral JSON number spellings", () => {
  // Given / When
  const single = CapabilityExecutionRequestSchema.parse({ ...common, ...operation, expectedRevision: JSON.parse("1.0") });
  const batch = CapabilityBatchExecutionRequestSchema.parse({ ...common, operations: [operation], expectedRevision: JSON.parse("1e0") });
  // Then
  expect(single.expectedRevision).toBe(1);
  expect(batch.expectedRevision).toBe(1);
});
