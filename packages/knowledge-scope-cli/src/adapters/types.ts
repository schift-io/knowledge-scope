import type { ProviderResult } from "@schift-io/context-pack"

import type { JsonValue } from "../json.js"

export type SourceClass = "activity_stream" | "document" | "records"

export type AdapterCapability = Readonly<{
  operationId: string
  inputSchemaRef: string
  resultSchemaRef: string
  allowedFilters?: readonly string[] | undefined
  limits?: Readonly<{ maxRows?: number | undefined; maxResultBytes?: number | undefined }> | undefined
  freshness?: Readonly<{ maxAgeSeconds: number }> | undefined
  requiredProviderScopes?: readonly string[] | undefined
}>

export type OpenConnectorCapability = AdapterCapability & Readonly<{
  provider: Readonly<{
    kind: "open_connector_action"
    actionId: string
    connectorRef: string
  }>
}>

export type SchiftSearchCapability = AdapterCapability & Readonly<{
  provider: Readonly<{ kind: "schift_search"; indexRef: string }>
}>

export type AdapterSourceBinding = Readonly<{
  sourceId: string
  sourceClass: SourceClass
  providerRef: string
  connectorRef?: string | undefined
  operationIds: readonly string[]
}>

export type AdapterExecutionRequest = Readonly<{
  input: JsonValue
  filters: Readonly<Record<string, JsonValue>>
  effectiveScope: TrustedEffectiveScope
  idempotencyKey?: string
  signal?: AbortSignal
}>

export type HttpRequest = Readonly<{
  url: string
  method: "GET" | "POST"
  headers: Readonly<Record<string, string>>
  body?: string
  signal: AbortSignal
  redirect: "error"
}>

export interface HttpResponseLike {
  readonly status: number
  readonly headers: Readonly<{ get(name: string): string | null }>
  readonly body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponseLike>

export type SchemaValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code?: string }>

export type SchemaValidator = (input: Readonly<{
  schemaRef: string
  value: JsonValue
  phase: "input" | "result"
}>) => SchemaValidationResult | Promise<SchemaValidationResult>

export const ADAPTER_FAILURE_CODES = [
  "action_not_read_only",
  "binding_mismatch",
  "filter_not_allowed",
  "input_schema_invalid",
  "invalid_configuration",
  "invalid_freshness",
  "invalid_idempotency_key",
  "invalid_url",
  "permission_evidence_missing",
  "provider_identity_mismatch",
  "provider_rejected",
  "provider_response_malformed",
  "provider_scope_missing",
  "provider_unavailable",
  "response_too_large",
  "result_schema_invalid",
  "result_stale",
  "schema_validator_missing",
  "too_many_rows",
  "unsafe_citation",
] as const

export type AdapterFailureCode = (typeof ADAPTER_FAILURE_CODES)[number]
export type AdapterFailure = Readonly<{
  code: AdapterFailureCode
  message: string
}>

export type CitationFact = Readonly<{ uri: string; label?: string }>

export type ProviderResultFact = ProviderResult

export type OpenConnectorNormalizedRow = Readonly<{
  resultId: string
  srn?: string
  revision: string
  freshness?: string
  payload: JsonValue
  citation?: CitationFact
}>

export type OpenConnectorRowNormalizer = (input: Readonly<{
  row: JsonValue
  connectorRunId: string
  actionCorrelationId: string
}>) => OpenConnectorNormalizedRow | Promise<OpenConnectorNormalizedRow>

export type OpenConnectorInputMapper = (input: Readonly<{
  input: JsonValue
  filters: Readonly<Record<string, JsonValue>>
  effectiveScope: TrustedEffectiveScope
  capability: OpenConnectorCapability
  binding: AdapterSourceBinding
}>) => JsonValue | Promise<JsonValue>

export type AdapterResult<TFact> =
  | Readonly<{ ok: true; facts: readonly TFact[] }>
  | Readonly<{ ok: false; error: AdapterFailure }>

export type OpenConnectorRuntime = Readonly<{
  baseUrl: string
  connectorAlias?: string
  bearerToken?: string
  grantedProviderScopes: readonly string[]
  readOnlyActions: readonly Readonly<{
    connectorRef: string
    connectorAlias: string
    actionId: string
  }>[]
  timeoutMs: number
}>

export type SchiftSearchRuntime = Readonly<{
  baseUrl: string
  tenant: string
  organizationId: string
  bearerToken: string
  grantedProviderScopes: readonly string[]
  timeoutMs: number
}>

export type TrustedEffectiveScope = Readonly<{
  tenant: string
  namespace?: string
  subject?: string
  session?: string
}>
