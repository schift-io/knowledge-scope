import { createHash } from "node:crypto"
import { ProviderResultSchema, type ProviderResult } from "@schift-io/context-pack"
import { z } from "zod"

import type { JsonValue } from "../json.js"
import { canonicalJson } from "../json.js"
import type { ProviderExecutionContext, ProviderExecutionPort } from "../application.js"
import { runOpenConnectorAction } from "./open-connector.js"
import { JsonValueSchema } from "./response.js"
import { runSchiftSearch } from "./schift-search.js"
import type {
  AdapterFailureCode,
  HttpTransport,
  OpenConnectorNormalizedRow,
  OpenConnectorInputMapper,
  OpenConnectorRowNormalizer,
  OpenConnectorRuntime,
  SchemaValidator,
  SchiftSearchRuntime,
  TrustedEffectiveScope,
} from "./types.js"

export class HttpProviderAdapterError extends Error {
  public override readonly name = "HttpProviderAdapterError"

  public constructor(public readonly code: AdapterFailureCode) {
    super(`Provider adapter failed: ${code}`)
  }
}

type SearchRuntimeResolution = Omit<SchiftSearchRuntime, "tenant">

export const bindTrustedSearchAuthority = (
  runtime: SearchRuntimeResolution,
  trustedTenant: string,
  trustedOrganizationId: string,
): SchiftSearchRuntime => {
  if (runtime.organizationId !== trustedOrganizationId) {
    throw new HttpProviderAdapterError("provider_identity_mismatch")
  }
  return { ...runtime, tenant: trustedTenant }
}

export interface HttpProviderRuntimeResolver {
  resolveOpenConnector(context: ProviderExecutionContext): OpenConnectorRuntime | Promise<OpenConnectorRuntime>
  resolveSchiftSearch(context: ProviderExecutionContext): SearchRuntimeResolution | Promise<SearchRuntimeResolution>
}

export type HttpProviderExecutionOptions = Readonly<{
  transport: HttpTransport
  runtimeResolver: HttpProviderRuntimeResolver
  executeRecords?: RecordsOperationExecutor
  mapOpenConnectorInput?: OpenConnectorInputMapper
  normalizeOpenConnectorRow?: OpenConnectorRowNormalizer
  now?: () => Date
}>

export type RecordsOperationExecutor = (
  context: ProviderExecutionContext,
) => Promise<readonly ProviderResult[]>

const DefaultConnectorRowSchema = z.object({
  resultId: z.string().min(1),
  srn: z.string().regex(/^srn:[a-z0-9][a-z0-9:._/-]+$/).optional(),
  revision: z.string().min(1),
  freshness: z.string().min(1),
  payload: JsonValueSchema,
  citation: z.object({ uri: z.string().min(1), label: z.string().min(1).optional() }).strict(),
}).strict()

export const normalizeDefaultOpenConnectorRow: OpenConnectorRowNormalizer = ({ row }) => {
  const parsed = DefaultConnectorRowSchema.safeParse(row)
  if (!parsed.success) throw new HttpProviderAdapterError("provider_response_malformed")
  const citation = parsed.data.citation.label === undefined
    ? { uri: parsed.data.citation.uri }
    : { uri: parsed.data.citation.uri, label: parsed.data.citation.label }
  return {
    resultId: parsed.data.resultId,
    ...(parsed.data.srn === undefined ? {} : { srn: parsed.data.srn }),
    revision: parsed.data.revision,
    freshness: parsed.data.freshness,
    payload: parsed.data.payload,
    citation,
  }
}

const validatorFor = (context: ProviderExecutionContext): SchemaValidator => ({ value, phase }) => {
  const result = phase === "input" ? context.validateInput(value) : context.validateResult(value)
  return result.valid ? { ok: true } : { ok: false, code: result.reason }
}

const trustedEffectiveScope = (context: ProviderExecutionContext): TrustedEffectiveScope => ({
  tenant: context.request.effectiveScope.tenant,
  ...(context.request.effectiveScope.namespace === undefined
    ? {} : { namespace: context.request.effectiveScope.namespace }),
  ...(context.request.effectiveScope.subject === undefined
    ? {} : { subject: context.request.effectiveScope.subject }),
  ...(context.request.effectiveScope.session === undefined
    ? {} : { session: context.request.effectiveScope.session }),
})

export const stableProviderIdempotencyKey = (context: ProviderExecutionContext): string => {
  const identity: JsonValue = {
    installationId: context.mount.installationId,
    operationId: context.capability.operationId,
    sourceId: context.binding.sourceId,
    input: context.request.input,
    filters: context.request.filters ?? {},
    effectiveScope: trustedEffectiveScope(context),
  }
  return `ks-${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`
}

const unwrap = <T>(result: Readonly<{
  ok: true
  facts: readonly T[]
}> | Readonly<{
  ok: false
  error: Readonly<{ code: AdapterFailureCode }>
}>): readonly T[] => {
  if (!result.ok) throw new HttpProviderAdapterError(result.error.code)
  return result.facts
}

export const createHttpProviderExecutionPort = (
  options: HttpProviderExecutionOptions,
): ProviderExecutionPort => ({
  execute: async (context) => {
    const request = {
      input: context.request.input,
      filters: context.request.filters ?? {},
      effectiveScope: trustedEffectiveScope(context),
    }
    const common = {
      binding: context.binding,
      request,
      transport: options.transport,
      validateSchema: validatorFor(context),
      ...(options.now === undefined ? {} : { now: options.now() }),
    }
    switch (context.capability.provider.kind) {
      case "open_connector_action": {
        const runtime = await options.runtimeResolver.resolveOpenConnector(context)
        const capability = {
          operationId: context.capability.operationId,
          provider: context.capability.provider,
          inputSchemaRef: context.capability.inputSchemaRef,
          resultSchemaRef: context.capability.resultSchemaRef,
          allowedFilters: context.capability.allowedFilters,
          limits: context.capability.limits,
          freshness: context.capability.freshness,
          requiredProviderScopes: context.capability.requiredProviderScopes,
        }
        return unwrap(await runOpenConnectorAction({
          ...common,
          capability,
          request: { ...request, idempotencyKey: stableProviderIdempotencyKey(context) },
          runtime,
          normalizeRow: options.normalizeOpenConnectorRow ?? normalizeDefaultOpenConnectorRow,
          ...(options.mapOpenConnectorInput === undefined ? {} : { mapInput: options.mapOpenConnectorInput }),
        }))
      }
      case "schift_search": {
        const runtime = await options.runtimeResolver.resolveSchiftSearch(context)
        const capability = {
          operationId: context.capability.operationId,
          provider: context.capability.provider,
          inputSchemaRef: context.capability.inputSchemaRef,
          resultSchemaRef: context.capability.resultSchemaRef,
          allowedFilters: context.capability.allowedFilters,
          limits: context.capability.limits,
          freshness: context.capability.freshness,
          requiredProviderScopes: context.capability.requiredProviderScopes,
        }
        return unwrap(await runSchiftSearch({
          ...common,
          capability,
          request: { ...request, effectiveScope: trustedEffectiveScope(context) },
          runtime: bindTrustedSearchAuthority(
            runtime,
            context.mount.scopeAuthority.tenant,
            context.mount.scopeAuthority.organizationId,
          ),
        }))
      }
      case "records_operation": {
        if (
          options.executeRecords === undefined ||
          context.request.operationId !== context.capability.operationId ||
          context.binding.providerRef !== context.capability.provider.operationId ||
          !context.binding.operationIds.includes(context.capability.operationId) ||
          !context.validateInput(context.request.input).valid
        ) {
          throw new HttpProviderAdapterError("invalid_configuration")
        }
        return (await options.executeRecords(context)).map((result) => {
          const parsed = ProviderResultSchema.safeParse(result)
          if (!parsed.success || !context.validateResult(parsed.data.payload).valid) {
            throw new HttpProviderAdapterError("result_schema_invalid")
          }
          return parsed.data
        })
      }
      case "local_documents":
      case "web_search":
        throw new HttpProviderAdapterError("invalid_configuration")
    }
  },
})
