import { describe, expect, it } from "bun:test";
import * as batch from "../src/knowledge-scope-batch.js";
import validRequest from "../fixtures/knowledge-scope/batch-request-valid.json";
import invalidRequests from "../fixtures/knowledge-scope/batch-request-invalid.json";

const request = {
  installationId: "ks-support",
  effectiveScope: { tenant: "acme" },
  expectedRevision: 1,
  operations: [{ operationId: "search.docs", input: { query: "reset" } }],
};

describe("CapabilityBatchExecutionRequest", () => {
  it("accepts bounded independent operations under one mount and scope", () => {
    // Given / When
    const parsed = batch.CapabilityBatchExecutionRequestSchema.safeParse(request);
    // Then
    expect(parsed.success).toBe(true);
  });

  it.each([
    { ...request, operations: [] },
    { ...request, operations: [...request.operations, ...request.operations] },
    { ...request, operations: Array.from({ length: 9 }, (_, i) => ({ operationId: `op.${i}`, input: null })) },
    { ...request, operations: [{ operationId: "search.docs", input: null, installationId: "other" }] },
    { ...request, expectedRevision: null },
    { ...request, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...request, operations: [{ operationId: "search.docs", input: null, filters: null }] },
  ])("rejects malformed batch boundaries %#", (raw) => {
    // Given / When
    const parsed = batch.CapabilityBatchExecutionRequestSchema.safeParse(raw);
    // Then
    expect(parsed.success).toBe(false);
  });

  it("accepts the shared TS/Python fixture without coercion", () => {
    // Given / When
    const parsed = batch.CapabilityBatchExecutionRequestSchema.parse(validRequest);
    // Then
    expect(parsed).toEqual(validRequest);
  });

  it.each(invalidRequests)("rejects the shared fixture $name", ({ request: raw }) => {
    // Given / When
    const parsed = batch.CapabilityBatchExecutionRequestSchema.safeParse(raw);
    // Then
    expect(parsed.success).toBe(false);
  });
});
