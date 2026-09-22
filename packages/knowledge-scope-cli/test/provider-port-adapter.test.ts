import { describe, expect, test } from "bun:test"
import {
  CapabilityExecutionRequestSchema,
  KnowledgeScopeDefinitionSchema,
  KnowledgeScopeMountSchema,
} from "@schift-io/context-pack"

import {
  createHttpProviderExecutionPort,
  bindTrustedSearchAuthority,
  HttpProviderAdapterError,
  normalizeDefaultOpenConnectorRow,
  stableProviderIdempotencyKey,
} from "../src/adapters/provider-port.js"
import type { HttpTransport } from "../src/adapters/types.js"

describe("HTTP provider execution port helpers", () => {
  test("rejects resolver organization drift and binds the mounted tenant", () => {
    const resolverOutput = {
      baseUrl: "https://search.example.test",
      tenant: "attacker-tenant",
      organizationId: "attacker-org",
      bearerToken: "search-secret",
      grantedProviderScopes: ["search:read"],
      timeoutMs: 1_000,
    }
    expect(() => bindTrustedSearchAuthority(resolverOutput, "mounted-tenant", "mounted-org"))
      .toThrow(HttpProviderAdapterError)
    const bound = bindTrustedSearchAuthority(
      { ...resolverOutput, organizationId: "mounted-org" },
      "mounted-tenant",
      "mounted-org",
    )
    expect(bound).toMatchObject({ tenant: "mounted-tenant", organizationId: "mounted-org" })
  })

  test("rejects resolver organization mismatch before any Search HTTP call", async () => {
    const definition = KnowledgeScopeDefinitionSchema.parse({
      packId: "search.scope", version: "0.1.0", responsibility: "search.scope",
      scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
      capabilities: [{
        operationId: "search.docs",
        provider: { kind: "schift_search", indexRef: "support-index" },
        inputSchemaRef: "schema/input.json", resultSchemaRef: "schema/result.json",
      }],
      contextPolicy: {
        mustConsider: [{ id: "required.docs", selector: { sourceIds: ["support.docs"] }, minEvidence: 1 }],
        mustNotUse: [{ id: "denied.records", selector: { sourceIds: ["denied.records"] } }],
      },
      authority: {
        precedence: ["primary"], allowed: ["read"],
        forbidden: ["send", "approve", "mutate_source", "workflow"],
      },
      evidence: {
        requireCitation: true, freshness: { defaultMaxAgeSeconds: 3_600 },
        coverageAssertions: ["required.docs"],
      },
    })
    const mount = KnowledgeScopeMountSchema.parse({
      installationId: "ks-search", definitionDigest: `sha256:${"c".repeat(64)}`,
      scopeAuthority: { organizationId: "mounted-org", tenant: "mounted-tenant" },
      sourceBindings: [{
        sourceId: "support.docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
      state: "mounted", revision: 1,
    })
    const capability = definition.capabilities[0]
    const binding = mount.sourceBindings[0]
    if (capability === undefined || binding === undefined) throw new TypeError("fixture is incomplete")
    const request = CapabilityExecutionRequestSchema.parse({
      installationId: "ks-search", operationId: "search.docs",
      effectiveScope: { tenant: "mounted-tenant" }, input: { query: "refund" },
    })
    let calls = 0
    const port = createHttpProviderExecutionPort({
      transport: async () => {
        calls += 1
        return Response.json({})
      },
      runtimeResolver: {
        resolveOpenConnector: () => { throw new TypeError("unexpected connector resolution") },
        resolveSchiftSearch: () => ({
          baseUrl: "https://search.example.test", organizationId: "other-org",
          bearerToken: "search-secret", grantedProviderScopes: [], timeoutMs: 1_000,
        }),
      },
    })
    await expect(port.execute({
      definition, mount, capability, binding, request,
      validateInput: () => ({ valid: true }), validateResult: () => ({ valid: true }),
    })).rejects.toMatchObject({ code: "provider_identity_mismatch" })
    expect(calls).toBe(0)
  })

  test("parses the strict default Open Connector normalized-row convention", () => {
    const normalized = normalizeDefaultOpenConnectorRow({
      row: {
        resultId: "record-1",
        srn: "srn:records/record-1",
        revision: "rev-1",
        freshness: "2026-09-22T00:00:00.000Z",
        payload: { id: "record-1" },
        citation: { uri: "https://example.test/records/1" },
      },
      connectorRunId: "run-1",
      actionCorrelationId: "crm.lookup",
    })
    expect(normalized).toEqual({
      resultId: "record-1",
      srn: "srn:records/record-1",
      revision: "rev-1",
      freshness: "2026-09-22T00:00:00.000Z",
      payload: { id: "record-1" },
      citation: { uri: "https://example.test/records/1" },
    })
  })

  test("rejects provider rows that try to add trusted identity fields", () => {
    expect(() => normalizeDefaultOpenConnectorRow({
      row: {
        resultId: "record-1",
        revision: "rev-1",
        freshness: "2026-09-22T00:00:00.000Z",
        payload: {},
        citation: { uri: "https://example.test/records/1" },
        installationId: "provider-controlled",
      },
      connectorRunId: "run-1",
      actionCorrelationId: "crm.lookup",
    })).toThrow(HttpProviderAdapterError)
  })

  test("fails closed for an unsupported provider kind before runtime resolution", async () => {
    const definition = KnowledgeScopeDefinitionSchema.parse({
      packId: "test.scope",
      version: "0.1.0",
      responsibility: "test.scope",
      scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
      capabilities: [{
        operationId: "records.lookup",
        provider: { kind: "records_operation", operationId: "records.lookup" },
        inputSchemaRef: "schema/input.json",
        resultSchemaRef: "schema/result.json",
      }],
      contextPolicy: {
        mustConsider: [{ id: "required.records", selector: { sourceIds: ["records.source"] }, minEvidence: 1 }],
        mustNotUse: [{ id: "denied.docs", selector: { sourceIds: ["denied.source"] } }],
      },
      authority: {
        precedence: ["primary"],
        allowed: ["read"],
        forbidden: ["send", "approve", "mutate_source", "workflow"],
      },
      evidence: {
        requireCitation: true,
        freshness: { defaultMaxAgeSeconds: 3_600 },
        coverageAssertions: ["required.records"],
      },
    })
    const mount = KnowledgeScopeMountSchema.parse({
      installationId: "ks-test",
      definitionDigest: `sha256:${"a".repeat(64)}`,
      scopeAuthority: { organizationId: "org-test", tenant: "tenant-test" },
      sourceBindings: [{
        sourceId: "records.source",
        sourceClass: "records",
        providerRef: "records.lookup",
        authority: "primary",
        permissionMode: "live",
        operationIds: ["records.lookup"],
      }],
      state: "mounted",
      revision: 1,
    })
    const request = CapabilityExecutionRequestSchema.parse({
      installationId: "ks-test",
      operationId: "records.lookup",
      effectiveScope: { tenant: "tenant-test" },
      input: {},
    })
    const capability = definition.capabilities[0]
    const binding = mount.sourceBindings[0]
    if (capability === undefined || binding === undefined) throw new TypeError("fixture is incomplete")
    let resolutions = 0
    const transport: HttpTransport = async () => Response.json({})
    const port = createHttpProviderExecutionPort({
      transport,
      runtimeResolver: {
        resolveOpenConnector: () => {
          resolutions += 1
          return { baseUrl: "https://example.test", grantedProviderScopes: [], readOnlyActions: [], timeoutMs: 1_000 }
        },
        resolveSchiftSearch: () => {
          resolutions += 1
          return { baseUrl: "https://example.test", organizationId: "org-test", bearerToken: "search-secret", grantedProviderScopes: [], timeoutMs: 1_000 }
        },
      },
    })
    await expect(port.execute({
      definition,
      mount,
      capability,
      binding,
      request,
      validateInput: () => ({ valid: true }),
      validateResult: () => ({ valid: true }),
    })).rejects.toMatchObject({ code: "invalid_configuration" })
    expect(resolutions).toBe(0)

    let recordCalls = 0
    const guarded = createHttpProviderExecutionPort({
      transport,
      runtimeResolver: {
        resolveOpenConnector: () => ({ baseUrl: "https://example.test", grantedProviderScopes: [], readOnlyActions: [], timeoutMs: 1_000 }),
        resolveSchiftSearch: () => ({ baseUrl: "https://example.test", organizationId: "org-test", bearerToken: "search-secret", grantedProviderScopes: [], timeoutMs: 1_000 }),
      },
      executeRecords: async () => {
        recordCalls += 1
        return []
      },
    })
    const arbitraryRequest = CapabilityExecutionRequestSchema.parse({
      installationId: "ks-test",
      operationId: "records.arbitrary",
      effectiveScope: { tenant: "tenant-test" },
      input: {},
    })
    await expect(guarded.execute({
      definition,
      mount,
      capability,
      binding,
      request: arbitraryRequest,
      validateInput: () => ({ valid: true }),
      validateResult: () => ({ valid: true }),
    })).rejects.toMatchObject({ code: "invalid_configuration" })
    expect(recordCalls).toBe(0)
  })

  test("dispatches only the declared named records operation through the injected port", async () => {
    const definition = KnowledgeScopeDefinitionSchema.parse({
      packId: "records.scope",
      version: "0.1.0",
      responsibility: "records.scope",
      scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
      capabilities: [{
        operationId: "records.lookup",
        provider: { kind: "records_operation", operationId: "records.lookup" },
        inputSchemaRef: "schema/input.json",
        resultSchemaRef: "schema/result.json",
        requiredProviderScopes: ["records:read"],
      }],
      contextPolicy: {
        mustConsider: [{ id: "required.records", selector: { sourceIds: ["records.source"] }, minEvidence: 1 }],
        mustNotUse: [{ id: "denied.docs", selector: { sourceIds: ["denied.source"] } }],
      },
      authority: {
        precedence: ["primary"],
        allowed: ["read"],
        forbidden: ["send", "approve", "mutate_source", "workflow"],
      },
      evidence: {
        requireCitation: true,
        freshness: { defaultMaxAgeSeconds: 3_600 },
        coverageAssertions: ["required.records"],
      },
    })
    const mount = KnowledgeScopeMountSchema.parse({
      installationId: "ks-records",
      definitionDigest: `sha256:${"b".repeat(64)}`,
      scopeAuthority: { organizationId: "org-test", tenant: "tenant-test" },
      sourceBindings: [{
        sourceId: "records.source",
        sourceClass: "records",
        providerRef: "records.lookup",
        authority: "primary",
        permissionMode: "live",
        operationIds: ["records.lookup"],
      }],
      state: "mounted",
      revision: 1,
    })
    const capability = definition.capabilities[0]
    const binding = mount.sourceBindings[0]
    if (capability === undefined || binding === undefined) throw new TypeError("fixture is incomplete")
    let dispatches = 0
    const port = createHttpProviderExecutionPort({
      transport: async () => Response.json({}),
      runtimeResolver: {
        resolveOpenConnector: () => { throw new TypeError("unexpected connector resolution") },
        resolveSchiftSearch: () => { throw new TypeError("unexpected search resolution") },
      },
      executeRecords: async () => {
        dispatches += 1
        return [{
          resultId: "record-1",
          revision: "rev-1",
          freshness: "2026-09-22T00:00:00.000Z",
          payload: { id: "record-1" },
          citation: { uri: "schift://records/record-1" },
          providerScopes: ["records:read"],
          providerEvidence: { kind: "records_operation", operationId: "records.lookup" },
        }]
      },
    })
    const declared = CapabilityExecutionRequestSchema.parse({
      installationId: "ks-records",
      operationId: "records.lookup",
      effectiveScope: { tenant: "tenant-test" },
      input: { id: "record-1" },
    })
    const context = {
      definition,
      mount,
      capability,
      binding,
      request: declared,
      validateInput: () => ({ valid: true } as const),
      validateResult: () => ({ valid: true } as const),
    }
    const retryKey = stableProviderIdempotencyKey(context)
    expect(stableProviderIdempotencyKey(context)).toBe(retryKey)
    const narrowerScope = CapabilityExecutionRequestSchema.parse({
      installationId: "ks-records",
      operationId: "records.lookup",
      effectiveScope: { tenant: "tenant-test", namespace: "support" },
      input: { id: "record-1" },
    })
    expect(stableProviderIdempotencyKey({ ...context, request: narrowerScope })).not.toBe(retryKey)
    const distinctInput = CapabilityExecutionRequestSchema.parse({
      installationId: "ks-records",
      operationId: "records.lookup",
      effectiveScope: { tenant: "tenant-test" },
      input: { id: "record-2" },
      filters: { status: "active" },
    })
    expect(stableProviderIdempotencyKey({ ...context, request: distinctInput })).not.toBe(retryKey)
    await expect(port.execute(context)).resolves.toEqual([{
      resultId: "record-1",
      revision: "rev-1",
      freshness: "2026-09-22T00:00:00.000Z",
      payload: { id: "record-1" },
      citation: { uri: "schift://records/record-1" },
      providerScopes: ["records:read"],
      providerEvidence: { kind: "records_operation", operationId: "records.lookup" },
    }])
    const rawSqlLike = CapabilityExecutionRequestSchema.parse({
      installationId: "ks-records",
      operationId: "sql.raw",
      effectiveScope: { tenant: "tenant-test" },
      input: { sql: "select * from secrets" },
    })
    await expect(port.execute({ ...context, request: rawSqlLike })).rejects.toMatchObject({
      code: "invalid_configuration",
    })
    expect(dispatches).toBe(1)
  })
})
