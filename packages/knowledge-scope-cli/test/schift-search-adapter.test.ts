import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { runSchiftSearch } from "../src/adapters/schift-search.js"
import { GLOBAL_MAX_RESULT_BYTES } from "../src/adapters/gates.js"
import type { HttpTransport, SchemaValidator } from "../src/adapters/types.js"

const capability = {
  operationId: "search.docs",
  provider: { kind: "schift_search" as const, indexRef: "support-index" },
  inputSchemaRef: "schema/search-input.json",
  resultSchemaRef: "schema/search-result.json",
  allowedFilters: ["locale"],
  limits: { maxRows: 2, maxResultBytes: 4_096 },
  freshness: { maxAgeSeconds: 3_600 },
  requiredProviderScopes: ["search:read"],
}
const binding = {
  sourceId: "support-docs",
  sourceClass: "document" as const,
  providerRef: "support-index",
  operationIds: ["search.docs"],
}
const validator: SchemaValidator = () => ({ ok: true })
const now = new Date("2026-09-22T00:00:00.000Z")
const statusBody = {
  status: "ready",
  operational_status: "ready",
  bucket_id: "support-index",
  last_indexed_at: "2026-09-21T23:59:00.000Z",
}
const resultRow = {
  chunk_id: "chunk-1",
  document_id: "document-1",
  source_id: "uploaded-source-1",
  text: "answer evidence",
  score: 0.95,
  metadata: { source_url: "https://docs.example.test/support/1", ignored: "not-promoted" },
  title: "Support 1",
  page: 1,
  section: "Refunds",
}
const retrieveBody = {
  status: "ready",
  operational_status: "ready",
  bucket_id: "support-index",
  query: "refund",
  results: [resultRow],
}

let server: ReturnType<typeof Bun.serve>
let baseUrl = ""
const observed: Array<Readonly<{ method: string; url: string; body: unknown; headers: Headers }>> = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = request.method === "GET" ? null : await request.json()
      observed.push({ method: request.method, url: request.url, body, headers: request.headers })
      return Response.json(request.url.endsWith("/search/status") ? statusBody : retrieveBody, {
        headers: { "x-ks-test-fixture": "schift-search-adapter" },
      })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

const transport: HttpTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: request.signal,
    redirect: request.redirect,
  })
  expect({ status: response.status, fixture: response.headers.get("x-ks-test-fixture") }).toEqual({
    status: 200, fixture: "schift-search-adapter",
  })
  return response
}

const runWith = async (fake: HttpTransport = transport) =>
  runSchiftSearch({
    capability,
    binding,
    request: {
      input: { query: "refund", knowledgeScope: { tenant: "attacker-tenant" } },
      filters: { locale: "en" },
      effectiveScope: { tenant: "acme" },
    },
    runtime: {
      baseUrl,
      tenant: "acme",
      organizationId: "org-acme",
      bearerToken: "search-secret",
      grantedProviderScopes: ["search:read"],
      timeoutMs: 1_000,
    },
    transport: fake,
    validateSchema: validator,
    now,
  })

const twoCallTransport = (
  status: unknown,
  retrieve: unknown,
): HttpTransport => async (request) => {
  return Response.json(request.method === "GET" ? status : retrieve)
}

describe("Schift Search adapter", () => {
  test("uses status plus retrieve and returns evidence-only ProviderResult facts", async () => {
    observed.length = 0
    const result = await runWith()
    expect(result).toEqual({
      ok: true,
      facts: [{
        resultId: "chunk-1",
        srn: expect.stringMatching(/^srn:schift:chunk:[a-f0-9]{64}$/),
        revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        freshness: "2026-09-21T23:59:00.000Z",
        payload: {
          chunkId: "chunk-1",
          documentId: "document-1",
          sourceId: "uploaded-source-1",
          text: "answer evidence",
          score: 0.95,
          metadata: { source_url: "https://docs.example.test/support/1", ignored: "not-promoted" },
        },
        citation: { uri: "https://docs.example.test/support/1" },
        providerScopes: ["search:read"],
        providerEvidence: { kind: "schift_search", indexRef: "support-index" },
      }],
    })
    expect(observed.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["GET", "/v2/buckets/support-index/search/status"],
      ["POST", "/v2/buckets/support-index/retrieve"],
    ])
    expect(observed[1]?.body).toEqual({
      query: "refund",
      filters: { locale: "en" },
      knowledgeScope: { tenant: "acme", effectiveScope: { tenant: "acme" } },
    })
    expect(observed[0]?.headers.get("x-schift-client")).toBe("knowledge-scope")
    expect(observed[0]?.headers.get("x-schift-knowledge-scope-tenant")).toBe("acme")
    expect(observed[0]?.headers.get("x-schift-knowledge-scope-organization")).toBe("org-acme")
    expect(observed[0]?.headers.get("x-org-id")).toBe("org-acme")
    expect(JSON.stringify(result)).not.toContain("search-secret")
  })

  test("rejects status/retrieve bucket or lifecycle mismatches", async () => {
    const cases = [
      [{ ...statusBody, bucket_id: "other" }, retrieveBody],
      [statusBody, { ...retrieveBody, bucket_id: "other" }],
      [statusBody, { ...retrieveBody, status: "empty", operational_status: "empty" }],
      [{ ...statusBody, last_indexed_at: null }, retrieveBody],
    ]
    for (const [status, retrieve] of cases) {
      const result = await runWith(twoCallTransport(status, retrieve))
      expect(result.ok).toBe(false)
    }
  })

  test("keeps content revisions stable and changes them when source content changes", async () => {
    const first = await runWith(twoCallTransport(statusBody, retrieveBody))
    const retry = await runWith(twoCallTransport(statusBody, retrieveBody))
    const changed = await runWith(twoCallTransport(statusBody, {
      ...retrieveBody,
      results: [{ ...resultRow, text: "changed evidence" }],
    }))
    expect(first.ok && retry.ok && changed.ok).toBe(true)
    if (!first.ok || !retry.ok || !changed.ok) throw new TypeError("search fixture failed")
    expect(first.facts[0]?.revision).toBe(retry.facts[0]?.revision)
    expect(changed.facts[0]?.revision).not.toBe(first.facts[0]?.revision)
  })

  test("rejects unsafe citations and invalid, stale, or future index freshness", async () => {
    const cases = [
      [statusBody, { ...retrieveBody, results: [{ ...resultRow, metadata: { source_url: "javascript:alert(1)" } }] }],
      [{ ...statusBody, last_indexed_at: "not-a-date" }, retrieveBody],
      [{ ...statusBody, last_indexed_at: "2026-09-22T00:02:00.000Z" }, retrieveBody],
      [{ ...statusBody, last_indexed_at: "2026-09-21T22:00:00.000Z" }, retrieveBody],
    ]
    for (const [status, retrieve] of cases) {
      const result = await runWith(twoCallTransport(status, retrieve))
      expect(result.ok).toBe(false)
    }
  })

  test("fails the whole operation for malformed identity or excessive rows", async () => {
    const malformed = { ...retrieveBody, results: [{ ...resultRow, source_id: null }] }
    const excessive = { ...retrieveBody, results: [resultRow, resultRow, resultRow] }
    const malformedResult = await runWith(twoCallTransport(statusBody, malformed))
    const excessiveResult = await runWith(twoCallTransport(statusBody, excessive))
    expect(malformedResult).toMatchObject({ ok: false, error: { code: "provider_identity_mismatch" } })
    expect(excessiveResult).toMatchObject({ ok: false, error: { code: "too_many_rows" } })
  })

  test("enforces global chunked ceilings when the capability omits byte limits", async () => {
    const chunked = (bytes: number): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes))
        controller.close()
      },
    }), { status: 200 })
    const noByteLimit = { ...capability, limits: { maxRows: 2 } }
    const runLimited = (fake: HttpTransport) => runSchiftSearch({
      capability: noByteLimit,
      binding,
      request: { input: { query: "refund" }, filters: {}, effectiveScope: { tenant: "acme" } },
      runtime: { baseUrl, tenant: "acme", organizationId: "org-acme", bearerToken: "search-secret", grantedProviderScopes: ["search:read"], timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      now,
    })
    let statusCalls = 0
    const statusOversize: HttpTransport = async (request) => {
      statusCalls += 1
      return chunked(65_537)
    }
    const statusResult = await runLimited(statusOversize)
    expect(statusResult).toMatchObject({ ok: false, error: { code: "response_too_large" } })
    expect(statusCalls).toBe(1)

    const retrieveOversize: HttpTransport = async (request) => {
      return request.method === "GET" ? Response.json(statusBody) : chunked(GLOBAL_MAX_RESULT_BYTES + 1)
    }
    const retrieveResult = await runLimited(retrieveOversize)
    expect(retrieveResult).toMatchObject({ ok: false, error: { code: "response_too_large" } })
  })

  test("fails before HTTP for scope/filter injection and without schema validation", async () => {
    let calls = 0
    const fake: HttpTransport = async () => {
      calls += 1
      return Response.json({})
    }
    const noScope = await runSchiftSearch({
      capability,
      binding,
      request: { input: { query: "refund" }, filters: {}, effectiveScope: { tenant: "acme" } },
      runtime: { baseUrl, tenant: "acme", organizationId: "org-acme", bearerToken: "search-secret", grantedProviderScopes: [], timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      now,
    })
    const injected = await runSchiftSearch({
      capability,
      binding,
      request: { input: { query: "refund" }, filters: { tenant: "other" }, effectiveScope: { tenant: "acme" } },
      runtime: { baseUrl, tenant: "acme", organizationId: "org-acme", bearerToken: "search-secret", grantedProviderScopes: ["search:read"], timeoutMs: 1_000 },
      transport: fake,
      validateSchema: validator,
      now,
    })
    const missing = await runSchiftSearch({
      capability,
      binding,
      request: { input: { query: "refund" }, filters: {}, effectiveScope: { tenant: "acme" } },
      runtime: { baseUrl, tenant: "acme", organizationId: "org-acme", bearerToken: "search-secret", grantedProviderScopes: ["search:read"], timeoutMs: 1_000 },
      transport: fake,
      validateSchema: undefined,
      now,
    })
    expect(noScope).toMatchObject({ ok: false, error: { code: "provider_scope_missing" } })
    expect(injected).toMatchObject({ ok: false, error: { code: "filter_not_allowed" } })
    expect(missing).toMatchObject({ ok: false, error: { code: "schema_validator_missing" } })
    expect(calls).toBe(0)
  })
})
