import { z } from "zod"
import { ProviderResultSchema } from "@schift-io/context-pack"

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
import type {
  AdapterResult,
  AdapterSourceBinding,
  HttpTransport,
  OpenConnectorCapability,
  OpenConnectorNormalizedRow,
  OpenConnectorInputMapper,
  OpenConnectorRowNormalizer,
  OpenConnectorRuntime,
  ProviderResultFact,
  SchemaValidator,
  TrustedEffectiveScope,
} from "./types.js"

const SuccessEnvelopeSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  data: JsonValueSchema,
  meta: z.object({
    actionId: z.string().min(1),
    executionId: z.string().min(1),
    auditPersisted: z.literal(true),
  }).strict(),
}).strict()

const NormalizedRowSchema = z.object({
  resultId: z.string().min(1),
  srn: z.string().regex(/^srn:[a-z0-9][a-z0-9:._/-]+$/).optional(),
  revision: z.string().min(1),
  freshness: z.string().min(1),
  payload: JsonValueSchema,
  citation: z.object({ uri: z.string().min(1), label: z.string().min(1).optional() }).strict(),
}).strict()

export type OpenConnectorAdapterInput = Readonly<{
  capability: OpenConnectorCapability
  binding: AdapterSourceBinding
  request: Readonly<{
    input: JsonValue
    filters: Readonly<Record<string, JsonValue>>
    effectiveScope: TrustedEffectiveScope
    idempotencyKey?: string
    signal?: AbortSignal
  }>
  runtime: OpenConnectorRuntime
  transport: HttpTransport
  validateSchema: SchemaValidator | undefined
  normalizeRow: OpenConnectorRowNormalizer | undefined
  mapInput?: OpenConnectorInputMapper
  now?: Date
}>

const requestHeaders = (
  runtime: OpenConnectorRuntime,
  idempotencyKey: string,
  connectorRef: string,
): Readonly<Record<string, string>> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-oo-connector-alias": runtime.connectorAlias ?? connectorRef,
  }
  if (runtime.bearerToken !== undefined) headers["authorization"] = `Bearer ${runtime.bearerToken}`
  return headers
}

const validateIdempotencyKey = (value: string | undefined): value is string =>
  value !== undefined && value.trim() === value && value.length > 0 &&
  new TextEncoder().encode(value).byteLength <= 255

const normalizeRows = async (
  rows: readonly JsonValue[],
  input: OpenConnectorAdapterInput,
  connectorRunId: string,
): Promise<AdapterResult<ProviderResultFact>> => {
  if (input.normalizeRow === undefined) {
    return { ok: false, error: failure("invalid_configuration", "Open Connector row normalizer is required") }
  }
  const facts: ProviderResultFact[] = []
  for (const row of rows) {
    const normalizedValue = await input.normalizeRow({
      row,
      connectorRunId,
      actionCorrelationId: input.request.idempotencyKey ?? "",
    })
    const parsed = NormalizedRowSchema.safeParse(normalizedValue)
    if (!parsed.success) {
      return { ok: false, error: failure("provider_response_malformed", "Normalized provider row is malformed") }
    }
    const schemaFailure = await validateSchema(
      input.validateSchema,
      input.capability.resultSchemaRef,
      parsed.data.payload,
      "result",
    )
    if (schemaFailure !== undefined) return { ok: false, error: schemaFailure }
    const citation = parsed.data.citation.label === undefined
      ? { uri: parsed.data.citation.uri }
      : { uri: parsed.data.citation.uri, label: parsed.data.citation.label }
    const citationFailure = validateCitation(citation)
    if (citationFailure !== undefined) return { ok: false, error: citationFailure }
    const freshnessFailure = validateFreshness(
      parsed.data.freshness,
      input.now ?? new Date(),
      input.capability.freshness?.maxAgeSeconds,
    )
    if (freshnessFailure !== undefined) return { ok: false, error: freshnessFailure }
    const providerResult = ProviderResultSchema.safeParse({
      resultId: parsed.data.resultId,
      ...(parsed.data.srn === undefined ? {} : { srn: parsed.data.srn }),
      revision: parsed.data.revision,
      freshness: parsed.data.freshness,
      payload: parsed.data.payload,
      citation,
      providerScopes: [...(input.capability.requiredProviderScopes ?? [])],
      providerEvidence: {
        kind: "open_connector_action",
        connectorRef: input.capability.provider.connectorRef,
        actionId: input.capability.provider.actionId,
        connectorRunId,
        actionCorrelationId: input.request.idempotencyKey ?? "",
        auditPersisted: true,
      },
    })
    if (!providerResult.success) {
      return { ok: false, error: failure("provider_response_malformed", "Provider result is malformed") }
    }
    facts.push(providerResult.data)
  }
  return { ok: true, facts }
}

export const runOpenConnectorAction = async (
  input: OpenConnectorAdapterInput,
): Promise<AdapterResult<ProviderResultFact>> => {
  const timeoutFailure = validateTimeout(input.runtime.timeoutMs)
  if (timeoutFailure !== undefined) return { ok: false, error: timeoutFailure }
  const safeBase = parseSafeBaseUrl(input.runtime.baseUrl)
  if (!safeBase.ok) return safeBase
  const bindingFailure = validateBinding(input.capability, input.binding, input.capability.provider.actionId)
  if (bindingFailure !== undefined) return { ok: false, error: bindingFailure }
  if (input.binding.connectorRef !== input.capability.provider.connectorRef) {
    return { ok: false, error: failure("binding_mismatch", "Connector identity does not match the source binding") }
  }
  const effectiveConnectorAlias = input.runtime.connectorAlias ?? input.binding.connectorRef
  if (!input.runtime.readOnlyActions.some((attestation) =>
    attestation.connectorRef === input.binding.connectorRef &&
    attestation.connectorAlias === effectiveConnectorAlias &&
    attestation.actionId === input.capability.provider.actionId)) {
    return { ok: false, error: failure("action_not_read_only", "Connector action lacks server read-only attestation") }
  }
  const filterFailure = validateFilters(input.capability.allowedFilters, input.request.filters)
  if (filterFailure !== undefined) return { ok: false, error: filterFailure }
  const hasFilters = Object.keys(input.request.filters).length > 0
  const hasNarrowScope = input.request.effectiveScope.namespace !== undefined ||
    input.request.effectiveScope.subject !== undefined || input.request.effectiveScope.session !== undefined
  if ((hasFilters || hasNarrowScope) && input.mapInput === undefined) {
    return { ok: false, error: failure("invalid_configuration", "Open Connector filters or narrowed Scope require an input mapper") }
  }
  const providerInput = input.mapInput === undefined
    ? input.request.input
    : await input.mapInput({
        input: input.request.input,
        filters: input.request.filters,
        effectiveScope: input.request.effectiveScope,
        capability: input.capability,
        binding: input.binding,
      })
  const scopeFailure = validateProviderScopes(
    input.capability.requiredProviderScopes,
    input.runtime.grantedProviderScopes,
  )
  if (scopeFailure !== undefined) return { ok: false, error: scopeFailure }
  const inputFailure = await validateSchema(
    input.validateSchema,
    input.capability.inputSchemaRef,
    providerInput,
    "input",
  )
  if (inputFailure !== undefined) return { ok: false, error: inputFailure }
  const idempotencyKey = input.request.idempotencyKey
  if (!validateIdempotencyKey(idempotencyKey)) {
    return { ok: false, error: failure("invalid_idempotency_key", "A stable idempotency key is required") }
  }

  const endpoint = new URL(`/v1/actions/${encodeURIComponent(input.capability.provider.actionId)}`, safeBase.url)
  let response
  try {
    response = await input.transport({
      url: endpoint.toString(),
      method: "POST",
      headers: requestHeaders(input.runtime, idempotencyKey, input.binding.connectorRef),
      body: JSON.stringify({ input: providerInput }),
      signal: requestSignal(input.request.signal, input.runtime.timeoutMs),
      redirect: "error",
    })
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error: failure("provider_unavailable", "Open Connector is unavailable") }
    }
    throw error
  }
  const provider = await readProviderResponse(response, input.capability.limits?.maxResultBytes)
  if (!provider.ok) return provider
  const envelope = SuccessEnvelopeSchema.safeParse(provider.value)
  if (!envelope.success || envelope.data.meta.actionId !== input.capability.provider.actionId) {
    return { ok: false, error: failure("provider_identity_mismatch", "Open Connector response identity is invalid") }
  }
  const rows = Array.isArray(envelope.data.data) ? envelope.data.data : [envelope.data.data]
  const rowFailure = validateRowCount(rows, input.capability.limits?.maxRows)
  if (rowFailure !== undefined) return { ok: false, error: rowFailure }
  const byteFailure = validateByteLength(envelope.data.data, input.capability.limits?.maxResultBytes)
  if (byteFailure !== undefined) return { ok: false, error: byteFailure }
  return normalizeRows(rows, input, envelope.data.meta.executionId)
}
