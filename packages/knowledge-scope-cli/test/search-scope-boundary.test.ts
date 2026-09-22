import { describe, expect, it } from "bun:test";

import { runSchiftSearch } from "../src/adapters/schift-search.js";

describe("Search scope enforcement", () => {
  it("rejects narrowed scope that the provider API cannot enforce before dispatch", async () => {
    // Given: Search enforces organization/bucket ACL but has no KS subject attestation.
    let calls = 0;
    const effectiveScope = { tenant: "acme", namespace: "support", subject: "customer-b" };

    // When
    const result = await runSchiftSearch({
      capability: {
        operationId: "search-docs",
        provider: { kind: "schift_search", indexRef: "support" },
        inputSchemaRef: "schemas/input.json",
        resultSchemaRef: "schemas/result.json",
      },
      binding: {
        sourceId: "support-docs", sourceClass: "document", providerRef: "support",
        operationIds: ["search-docs"],
      },
      request: { input: { query: "policy" }, filters: {}, effectiveScope },
      runtime: {
        baseUrl: "https://api.example.test", tenant: "acme", organizationId: "org-acme",
        bearerToken: "never-emit", grantedProviderScopes: [], timeoutMs: 1_000,
      },
      transport: async () => { calls += 1; return Response.json({}); },
      validateSchema: () => ({ ok: true }),
    });

    // Then: no organization-wide evidence can be relabeled as customer-scoped.
    expect(result).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });
    expect(calls).toBe(0);
  });
});
