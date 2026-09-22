import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { runOpenConnectorAction } from "../src/adapters/open-connector.js"
import { GLOBAL_MAX_RESULT_BYTES } from "../src/adapters/gates.js"
import type { HttpTransport, OpenConnectorInputMapper, SchemaValidator } from "../src/adapters/types.js"

const validator: SchemaValidator = ({ value }) => ({ ok: value !== null })

const capability = {
  operationId: "lookup.customer",
  provider: {
    kind: "open_connector_action" as const,
    actionId: "crm.lookup",
    connectorRef: "crm",
  },
  inputSchemaRef: "schema/input.json",
  resultSchemaRef: "schema/result.json",
  allowedFilters: ["status"],
  limits: { maxRows: 2, maxResultBytes: 2_048 },
  requiredProviderScopes: ["records:read"],
}

const binding = {
  sourceId: "crm-records",
  sourceClass: "records" as const,
  providerRef: "crm.lookup",
  connectorRef: "crm",
  operationIds: ["lookup.customer"],
}
const trustedScope = { tenant: "acme", namespace: "support" }
const tenantOnlyScope = { tenant: "acme" }
const readOnlyActions = [
  { connectorRef: "crm", connectorAlias: "crm", actionId: "crm.lookup" },
  { connectorRef: "crm", connectorAlias: "work", actionId: "crm.lookup" },
]

const normalizedAt = new Date("2026-09-22T00:00:00.000Z")
const normalizeRow = ({ row }: { readonly row: import("../src/json.js").JsonValue }) => ({
  resultId: "customer-1",
  revision: "rev-1",
  freshness: "2026-09-21T23:59:00.000Z",
  payload: row,
  citation: { uri: "https://crm.example.test/customers/1", label: "Customer 1" },
})
const mapInput: OpenConnectorInputMapper = ({ input, filters, effectiveScope }) => ({
  request: input,
  where: filters,
  knowledgeScope: {
    tenant: effectiveScope.tenant,
    ...(effectiveScope.namespace === undefined ? {} : { namespace: effectiveScope.namespace }),
    ...(effectiveScope.subject === undefined ? {} : { subject: effectiveScope.subject }),
    ...(effectiveScope.session === undefined ? {} : { session: effectiveScope.session }),
  },
})

let server: ReturnType<typeof Bun.serve>
let baseUrl = ""
let observedHeaders: Headers | undefined
let observedBody: unknown

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "GET") {
        return Response.json({ id: "run-123", actionId: "crm.lookup", caller: "http", ok: true })
      }
      observedHeaders = request.headers
      const body = await request.json()
      observedBody = body
      return Response.json({
        success: true,
        message: "OK",
        data: [{ id: "customer-1", request: body, effectiveScope: { tenant: "attacker" } }],
        meta: {
          actionId: "crm.lookup",
          executionId: "run-123",
          auditPersisted: true,
        },
      })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

const transport: HttpTransport = async (request) =>
  fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: request.signal,
    redirect: request.redirect,
  })

describe("Open Connector adapter", () => {
  test("returns only provider facts after a real localhost round trip", async () => {
    const result = await runOpenConnectorAction({
      capability,
      binding,
      request: {
        input: { customerId: "customer-1" },
        filters: { status: "active" },
        effectiveScope: trustedScope,
        idempotencyKey: "scope-run-123",
      },
      runtime: {
        baseUrl,
        connectorAlias: "work",
        bearerToken: "top-secret",
        grantedProviderScopes: ["records:read"],
        readOnlyActions,
        timeoutMs: 1_000,
      },
      transport,
      validateSchema: validator,
      normalizeRow,
      mapInput,
      now: normalizedAt,
    })

    expect(result).toMatchObject({ ok: true, facts: [{
      resultId: "customer-1",
      providerEvidence: {
        kind: "open_connector_action",
        connectorRef: "crm",
        actionId: "crm.lookup",
        connectorRunId: "run-123",
        actionCorrelationId: "scope-run-123",
        auditPersisted: true,
      },
    }] })
    expect(observedHeaders?.get("x-oo-connector-alias")).toBe("work")
    expect(observedHeaders?.get("idempotency-key")).toBe("scope-run-123")
    expect(observedHeaders?.get("authorization")).toBe("Bearer top-secret")
    expect(observedBody).toEqual({
      input: {
        request: { customerId: "customer-1" },
        where: { status: "active" },
        knowledgeScope: trustedScope,
      },
    })
    expect(JSON.stringify(result)).not.toContain("top-secret")
    if (!result.ok) throw new TypeError("fixture failed")
    expect(Object.hasOwn(result.facts[0] ?? {}, "effectiveScope")).toBe(false)
  })

  test("fails before transport when a provider scope is missing", async () => {
    let calls = 0
    const fake: HttpTransport = async () => {
      calls += 1
      return Response.json({})
    }
    const result = await runOpenConnectorAction({
      capability,
      binding,
      request: { input: {}, filters: {}, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-run-1" },
      runtime: { baseUrl, grantedProviderScopes: [], readOnlyActions, timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
    })
    expect(result).toMatchObject({ ok: false, error: { code: "provider_scope_missing" } })
    expect(calls).toBe(0)
  })

  test("never dispatches an unattested action or connector instance", async () => {
    let calls = 0
    const fake: HttpTransport = async () => {
      calls += 1
      return Response.json({})
    }
    const writeCapability = {
      ...capability,
      operationId: "delete.customer",
      provider: { ...capability.provider, actionId: "crm.delete" },
    }
    const result = await runOpenConnectorAction({
      capability: writeCapability,
      binding: { ...binding, providerRef: "crm.delete", operationIds: ["delete.customer"] },
      request: { input: { customerId: "customer-1" }, filters: {}, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-write" },
      runtime: {
        baseUrl,
        grantedProviderScopes: ["records:read"],
        readOnlyActions,
        timeoutMs: 1_000,
      },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
    })
    expect(result).toMatchObject({ ok: false, error: { code: "action_not_read_only" } })
    const drifted = await runOpenConnectorAction({
      capability: { ...capability, provider: { ...capability.provider, connectorRef: "crm-other" } },
      binding: { ...binding, connectorRef: "crm-other" },
      request: { input: {}, filters: {}, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-drift" },
      runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
    })
    expect(drifted).toMatchObject({ ok: false, error: { code: "action_not_read_only" } })
    expect(calls).toBe(0)
  })

  test("fails closed on disallowed filters and absent schema validation", async () => {
    const disallowed = await runOpenConnectorAction({
      capability,
      binding,
      request: { input: {}, filters: { tenant: "other" }, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-run-2" },
      runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
      transport,
      validateSchema: validator,
      normalizeRow,
    })
    const missing = await runOpenConnectorAction({
      capability,
      binding,
      request: { input: {}, filters: {}, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-run-3" },
      runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
      transport,
      validateSchema: undefined,
      normalizeRow,
    })
    expect(disallowed).toMatchObject({ ok: false, error: { code: "filter_not_allowed" } })
    expect(missing).toMatchObject({ ok: false, error: { code: "schema_validator_missing" } })
  })

  test("does not dispatch allowed filters without an explicit mapper and validates mapped input", async () => {
    let calls = 0
    const fake: HttpTransport = async () => {
      calls += 1
      return Response.json({})
    }
    const unmapped = await runOpenConnectorAction({
      capability,
      binding,
      request: { input: {}, filters: { status: "active" }, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-unmapped" },
      runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
    })
    const unmappedNarrowScope = await runOpenConnectorAction({
      capability,
      binding,
      request: {
        input: {}, filters: {}, effectiveScope: trustedScope, idempotencyKey: "scope-unmapped-narrow",
      },
      runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
    })
    const invalidMapped = await runOpenConnectorAction({
      capability,
      binding,
      request: { input: {}, filters: { status: "active" }, effectiveScope: trustedScope, idempotencyKey: "scope-bad-map" },
      runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
      mapInput: () => null,
    })
    expect(unmapped).toMatchObject({ ok: false, error: { code: "invalid_configuration" } })
    expect(unmappedNarrowScope).toMatchObject({ ok: false, error: { code: "invalid_configuration" } })
    expect(invalidMapped).toMatchObject({ ok: false, error: { code: "input_schema_invalid" } })
    expect(calls).toBe(0)
  })

  test("returns no facts for mismatched, unaudited, malformed, or oversized responses", async () => {
    const cases = [
      { success: true, data: [], meta: { actionId: "other", executionId: "run-1", auditPersisted: true } },
      { success: true, data: [], meta: { actionId: "crm.lookup", executionId: "run-1", auditPersisted: false } },
      { success: true, data: [], meta: { actionId: "crm.lookup", executionId: "", auditPersisted: true } },
      { success: true, data: [{ id: 1 }, { id: 2 }, { id: 3 }], meta: { actionId: "crm.lookup", executionId: "run-1", auditPersisted: true } },
    ]
    for (const body of cases) {
      const fake: HttpTransport = async () => Response.json(body)
      const result = await runOpenConnectorAction({
        capability,
        binding,
        request: { input: {}, filters: {}, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-run-4" },
        runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
        transport: fake,
        validateSchema: validator,
        normalizeRow,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(JSON.stringify(result.error)).not.toContain("top-secret")
    }
  })

  test("rejects unsafe HTTP targets before transport", async () => {
    let calls = 0
    const fake: HttpTransport = async () => {
      calls += 1
      return Response.json({})
    }
    const result = await runOpenConnectorAction({
      capability,
      binding,
      request: { input: {}, filters: {}, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-run-5" },
      runtime: {
        baseUrl: "http://example.com",
        grantedProviderScopes: ["records:read"],
        readOnlyActions,
        timeoutMs: 1_000,
      },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
    })
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_url" } })
    expect(calls).toBe(0)
  })

  test("cancels a chunked response as soon as the byte ceiling is exceeded", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"))
        controller.enqueue(new Uint8Array(3_000))
        controller.close()
      },
    })
    const fake: HttpTransport = async () => new Response(oversized, { status: 200 })
    const result = await runOpenConnectorAction({
      capability,
      binding,
      request: { input: {}, filters: {}, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-run-6" },
      runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
    })
    expect(result).toMatchObject({ ok: false, error: { code: "response_too_large" } })
  })

  test("enforces the global byte ceiling when the capability omits maxResultBytes", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(GLOBAL_MAX_RESULT_BYTES))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })
    const fake: HttpTransport = async () => new Response(oversized, { status: 200 })
    const result = await runOpenConnectorAction({
      capability: { ...capability, limits: { maxRows: 2 } },
      binding,
      request: { input: {}, filters: {}, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-global-limit" },
      runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
    })
    expect(result).toMatchObject({ ok: false, error: { code: "response_too_large" } })
  })

  test("returns no facts for provider rejection or transport failure", async () => {
    const rejected: HttpTransport = async () => Response.json({ error: "secret detail" }, { status: 503 })
    const unavailable: HttpTransport = async () => {
      throw new DOMException("aborted", "AbortError")
    }
    const makeInput = (fake: HttpTransport) => ({
      capability,
      binding,
      request: { input: {}, filters: {}, effectiveScope: tenantOnlyScope, idempotencyKey: "scope-run-7" },
      runtime: { baseUrl, grantedProviderScopes: ["records:read"], readOnlyActions, timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      normalizeRow,
    })
    const rejectedResult = await runOpenConnectorAction(makeInput(rejected))
    const unavailableResult = await runOpenConnectorAction(makeInput(unavailable))
    expect(rejectedResult).toMatchObject({ ok: false, error: { code: "provider_rejected" } })
    expect(unavailableResult).toMatchObject({ ok: false, error: { code: "provider_unavailable" } })
    expect(JSON.stringify(rejectedResult)).not.toContain("secret detail")
  })

})
