import { ProviderResultSchema } from "@schift-io/context-pack"
import { z } from "zod"

import type { JsonValue } from "../json.js"
import { validateCitation, validateFreshness } from "./evidence-policy.js"
import {
  failure,
  validateBinding,
  validateByteLength,
  validateFilters,
  validateProviderScopes,
  validateRowCount,
  validateSchema,
  validateTimeout,
} from "./gates.js"
import { parseSafeBaseUrl, requestSignal } from "./http-policy.js"
import { JsonValueSchema, readProviderResponse } from "./response.js"
import { searchRequestHeaders } from "./schift-search-headers.js"
import { canonicalSearchSrn, searchContentRevision } from "./schift-search-identity.js"
import type {
  AdapterResult,
  AdapterSourceBinding,
  HttpTransport,
  ProviderResultFact,
  SchemaValidator,
  SchiftSearchCapability,
  SchiftSearchRuntime,
  TrustedEffectiveScope,
} from "./types.js"

const STATUS_MAX_BYTES = 65_536
const SearchInputSchema = z.object({ query: z.string().min(1) }).passthrough()
const StatusSchema = z.object({
  status: z.enum(["ready", "empty"]),
  operational_status: z.enum(["ready", "empty", "indexing", "degraded"]),
  bucket_id: z.string().min(1),
  last_indexed_at: z.string().min(1),
}).passthrough()
const RetrieveResultSchema = z.object({
  chunk_id: z.string().min(1),
  document_id: z.string().min(1),
  source_id: z.string().min(1),
  text: z.string(),
  score: z.number().finite(),
  metadata: z.record(JsonValueSchema).nullable().optional(),
  title: z.string().min(1).nullable().optional(),
  page: z.number().int().nullable().optional(),
  section: z.string().min(1).nullable().optional(),
}).passthrough()
const RetrieveSchema = z.object({
  status: z.enum(["ready", "empty"]),
  operational_status: z.enum(["ready", "empty", "indexing", "degraded"]),
  bucket_id: z.string().min(1),
  query: z.string().min(1),
  results: z.array(RetrieveResultSchema),
}).passthrough()

export type SchiftSearchAdapterInput = Readonly<{
  capability: SchiftSearchCapability
  binding: AdapterSourceBinding
  request: Readonly<{
    input: JsonValue
    filters: Readonly<Record<string, JsonValue>>
    effectiveScope: TrustedEffectiveScope
    signal?: AbortSignal
  }>
  runtime: SchiftSearchRuntime
  transport: HttpTransport
  validateSchema: SchemaValidator | undefined
  now?: Date
}>

const safeCitation = (
  metadata: Readonly<Record<string, JsonValue>> | null | undefined,
  bucket: string,
  chunk: string,
): Readonly<{ uri: string }> => {
  const sourceUrl = metadata?.["source_url"]
  if (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== "string") {
    throw new HttpSearchNormalizationError("unsafe_citation")
  }
  return {
    uri: typeof sourceUrl === "string"
      ? sourceUrl
      : `schift://buckets/${encodeURIComponent(bucket)}/chunks/${encodeURIComponent(chunk)}`,
  }
}

class HttpSearchNormalizationError extends Error {
  public override readonly name = "HttpSearchNormalizationError"

  public constructor(public readonly code: "provider_response_malformed" | "unsafe_citation") {
    super(`Search normalization failed: ${code}`)
  }
}

const normalizeRows = async (
  rows: z.infer<typeof RetrieveResultSchema>[],
  input: SchiftSearchAdapterInput,
  freshness: string,
): Promise<AdapterResult<ProviderResultFact>> => {
  const facts: ProviderResultFact[] = []
  for (const row of rows) {
    let citation: Readonly<{ uri: string }>
    try {
      citation = safeCitation(row.metadata, input.capability.provider.indexRef, row.chunk_id)
    } catch (error) {
      if (error instanceof HttpSearchNormalizationError) {
        return { ok: false, error: failure(error.code, "Search citation is malformed") }
      }
      throw error
    }
    const citationFailure = validateCitation(citation)
    if (citationFailure !== undefined) return { ok: false, error: citationFailure }
    // Provider-native source/document/chunk identities stay in evidence. The application
    // intentionally adds Candidate.sourceId from the mounted logical binding later.
    const payload: JsonValue = {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      sourceId: row.source_id,
      text: row.text,
      score: row.score,
      ...(row.metadata === undefined || row.metadata === null ? {} : { metadata: row.metadata }),
    }
    const schemaFailure = await validateSchema(
      input.validateSchema,
      input.capability.resultSchemaRef,
      payload,
      "result",
    )
    if (schemaFailure !== undefined) return { ok: false, error: schemaFailure }
    const identity = {
      bucket: input.capability.provider.indexRef,
      source: row.source_id,
      document: row.document_id,
      chunk: row.chunk_id,
      text: row.text,
      metadata: row.metadata ?? null,
      title: row.title ?? null,
      page: row.page ?? null,
      section: row.section ?? null,
    }
    const providerResult = ProviderResultSchema.safeParse({
      resultId: row.chunk_id,
      srn: canonicalSearchSrn(identity),
      revision: searchContentRevision(identity),
      freshness,
      payload,
      citation,
      providerScopes: [...(input.capability.requiredProviderScopes ?? [])],
      providerEvidence: { kind: "schift_search", indexRef: input.capability.provider.indexRef },
    })
    if (!providerResult.success) {
      return { ok: false, error: failure("provider_response_malformed", "Provider result is malformed") }
    }
    facts.push(providerResult.data)
  }
  return { ok: true, facts }
}

const requestProvider = async (
  input: SchiftSearchAdapterInput,
  url: URL,
  method: "GET" | "POST",
  body: string | undefined,
  maxBytes: number,
): Promise<Awaited<ReturnType<typeof readProviderResponse>>> => {
  try {
    const response = await input.transport({
      url: url.toString(), method, headers: searchRequestHeaders(input.runtime),
      ...(body === undefined ? {} : { body }),
      signal: requestSignal(input.request.signal, input.runtime.timeoutMs), redirect: "error",
    })
    return readProviderResponse(response, maxBytes)
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error: failure("provider_unavailable", "Schift Search is unavailable") }
    }
    throw error
  }
}

export const runSchiftSearch = async (
  input: SchiftSearchAdapterInput,
): Promise<AdapterResult<ProviderResultFact>> => {
  const timeoutFailure = validateTimeout(input.runtime.timeoutMs)
  if (timeoutFailure !== undefined) return { ok: false, error: timeoutFailure }
  const safeBase = parseSafeBaseUrl(input.runtime.baseUrl)
  if (!safeBase.ok) return safeBase
  if (input.request.effectiveScope.tenant !== input.runtime.tenant) {
    return { ok: false, error: failure("binding_mismatch", "Search runtime tenant does not match effective Scope") }
  }
  const scope = input.request.effectiveScope
  if (scope.namespace !== undefined || scope.subject !== undefined || scope.session !== undefined) {
    return { ok: false, error: failure("binding_mismatch", "Search supports only the mounted bucket Scope") }
  }
  const bindingFailure = validateBinding(input.capability, input.binding, input.capability.provider.indexRef)
  if (bindingFailure !== undefined) return { ok: false, error: bindingFailure }
  const filterFailure = validateFilters(input.capability.allowedFilters, input.request.filters)
  if (filterFailure !== undefined) return { ok: false, error: filterFailure }
  const scopeFailure = validateProviderScopes(
    input.capability.requiredProviderScopes, input.runtime.grantedProviderScopes,
  )
  if (scopeFailure !== undefined) return { ok: false, error: scopeFailure }
  const inputFailure = await validateSchema(
    input.validateSchema, input.capability.inputSchemaRef, input.request.input, "input",
  )
  if (inputFailure !== undefined) return { ok: false, error: inputFailure }
  const searchInput = SearchInputSchema.safeParse(input.request.input)
  if (!searchInput.success) {
    return { ok: false, error: failure("input_schema_invalid", "Schift Search input requires a query") }
  }
  const bucket = encodeURIComponent(input.capability.provider.indexRef)
  const statusResponse = await requestProvider(
    input, new URL(`/v2/buckets/${bucket}/search/status`, safeBase.url), "GET", undefined, STATUS_MAX_BYTES,
  )
  if (!statusResponse.ok) return statusResponse
  const status = StatusSchema.safeParse(statusResponse.value)
  if (!status.success || status.data.bucket_id !== input.capability.provider.indexRef ||
    !["ready", "empty"].includes(status.data.operational_status)) {
    return { ok: false, error: failure("provider_identity_mismatch", "Search status is not usable") }
  }
  const freshnessFailure = validateFreshness(
    status.data.last_indexed_at, input.now ?? new Date(), input.capability.freshness?.maxAgeSeconds,
  )
  if (freshnessFailure !== undefined) return { ok: false, error: freshnessFailure }
  const retrieveResponse = await requestProvider(
    input,
    new URL(`/v2/buckets/${bucket}/retrieve`, safeBase.url),
    "POST",
    JSON.stringify({
      ...searchInput.data,
      filters: input.request.filters,
      knowledgeScope: {
        tenant: input.runtime.tenant,
        effectiveScope: input.request.effectiveScope,
      },
    }),
    input.capability.limits?.maxResultBytes ?? Number.MAX_SAFE_INTEGER,
  )
  if (!retrieveResponse.ok) return retrieveResponse
  const retrieved = RetrieveSchema.safeParse(retrieveResponse.value)
  if (!retrieved.success || retrieved.data.bucket_id !== input.capability.provider.indexRef ||
    retrieved.data.status !== status.data.status || retrieved.data.operational_status !== status.data.operational_status) {
    return { ok: false, error: failure("provider_identity_mismatch", "Search retrieval identity is invalid") }
  }
  const rowFailure = validateRowCount(retrieved.data.results, input.capability.limits?.maxRows)
  if (rowFailure !== undefined) return { ok: false, error: rowFailure }
  const byteFailure = validateByteLength(retrieveResponse.value, input.capability.limits?.maxResultBytes)
  if (byteFailure !== undefined) return { ok: false, error: byteFailure }
  return normalizeRows(retrieved.data.results, input, status.data.last_indexed_at)
}
