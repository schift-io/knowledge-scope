import { canonicalJson, type JsonValue } from "../json.js"
import type {
  AdapterCapability,
  AdapterFailure,
  AdapterSourceBinding,
  SchemaValidator,
} from "./types.js"

export const GLOBAL_MAX_RESULT_BYTES = 8 * 1024 * 1024
export const GLOBAL_MAX_ROWS = 100

const fail = (code: AdapterFailure["code"], message: string): AdapterFailure => ({ code, message })

export const validateBinding = (
  capability: AdapterCapability,
  binding: AdapterSourceBinding,
  expectedProviderRef: string,
): AdapterFailure | undefined => {
  if (!binding.operationIds.includes(capability.operationId)) {
    return fail("binding_mismatch", "Operation is not declared by the source binding")
  }
  if (binding.providerRef !== expectedProviderRef) {
    return fail("binding_mismatch", "Provider identity does not match the source binding")
  }
  return undefined
}

export const validateFilters = (
  allowed: readonly string[] | undefined,
  filters: Readonly<Record<string, JsonValue>>,
): AdapterFailure | undefined => {
  const allowedKeys = new Set(allowed ?? [])
  return Object.keys(filters).every((key) => allowedKeys.has(key))
    ? undefined
    : fail("filter_not_allowed", "Request contains a filter not declared by the capability")
}

export const validateProviderScopes = (
  required: readonly string[] | undefined,
  granted: readonly string[],
): AdapterFailure | undefined => {
  const grantedScopes = new Set(granted)
  return (required ?? []).every((scope) => grantedScopes.has(scope))
    ? undefined
    : fail("provider_scope_missing", "Provider grant does not satisfy the capability")
}

export const validateRowCount = (
  rows: readonly unknown[],
  maxRows: number | undefined,
): AdapterFailure | undefined =>
  rows.length > (maxRows ?? GLOBAL_MAX_ROWS)
    ? fail("too_many_rows", "Provider response exceeds the declared row limit")
    : undefined

export const canonicalByteLength = (value: JsonValue): number =>
  new TextEncoder().encode(canonicalJson(value)).byteLength

export const validateByteLength = (
  value: JsonValue,
  maxBytes: number | undefined,
): AdapterFailure | undefined =>
  canonicalByteLength(value) > Math.min(maxBytes ?? GLOBAL_MAX_RESULT_BYTES, GLOBAL_MAX_RESULT_BYTES)
    ? fail("response_too_large", "Provider response exceeds the declared byte limit")
    : undefined

export const validateSchema = async (
  validator: SchemaValidator | undefined,
  schemaRef: string,
  value: JsonValue,
  phase: "input" | "result",
): Promise<AdapterFailure | undefined> => {
  if (validator === undefined) {
    return fail("schema_validator_missing", "A schema validator is required")
  }
  const result = await validator({ schemaRef, value, phase })
  if (result.ok) return undefined
  return fail(
    phase === "input" ? "input_schema_invalid" : "result_schema_invalid",
    `${phase === "input" ? "Input" : "Result"} does not match its declared schema`,
  )
}

export const validateTimeout = (timeoutMs: number): AdapterFailure | undefined =>
  Number.isInteger(timeoutMs) && timeoutMs > 0
    ? undefined
    : fail("invalid_configuration", "Adapter timeout must be a positive integer")

export const failure = fail
