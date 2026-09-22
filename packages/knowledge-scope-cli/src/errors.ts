export const KNOWLEDGE_SCOPE_ERROR_CODES = [
  "authorization_invalid",
  "batch_incomplete",
  "binding_limit_exceeded",
  "candidate_invalid",
  "candidate_limit_exceeded",
  "capability_not_found",
  "definition_invalid",
  "duplicate_json_key",
  "installation_not_found",
  "installation_not_mounted",
  "invalid_json",
  "json_limits_exceeded",
  "lock_conflict",
  "lock_invalid",
  "mount_conflict",
  "operation_not_bound",
  "path_invalid",
  "portable_file_extra",
  "portable_file_missing",
  "provider_result_invalid",
  "result_limits_exceeded",
  "scope_invalid",
  "schema_depth_exceeded",
  "state_corrupt",
  "state_capacity_exceeded",
  "state_permissions_invalid",
  "unsupported_schema_keyword",
  "value_schema_mismatch",
] as const;

export type KnowledgeScopeErrorCode = (typeof KNOWLEDGE_SCOPE_ERROR_CODES)[number];

const REDACTED_MESSAGES: Readonly<Record<KnowledgeScopeErrorCode, string>> = {
  authorization_invalid: "Candidate authorization is not trusted",
  batch_incomplete: "A requested operation returned no evidence",
  binding_limit_exceeded: "Knowledge Scope mount exceeds the binding limit",
  candidate_invalid: "Candidate failed admission",
  candidate_limit_exceeded: "Candidate batch exceeds the admission limit",
  capability_not_found: "Knowledge Scope capability was not found",
  definition_invalid: "Knowledge Scope definition is invalid",
  duplicate_json_key: "JSON contains a duplicate object key",
  installation_not_found: "Knowledge Scope installation was not found",
  installation_not_mounted: "Knowledge Scope installation is not mounted",
  invalid_json: "File is not valid JSON",
  json_limits_exceeded: "JSON exceeds the supported resource limits",
  lock_conflict: "Knowledge Scope state is locked by another process",
  lock_invalid: "Portable Scope lock verification failed",
  mount_conflict: "Knowledge Scope mount revision changed",
  operation_not_bound: "Capability has no mounted source binding",
  path_invalid: "Portable Scope path is unsafe",
  portable_file_extra: "Portable Scope contains an undeclared JSON file",
  portable_file_missing: "Portable Scope is missing a declared file",
  provider_result_invalid: "Provider returned an invalid result",
  result_limits_exceeded: "Provider result exceeds the declared limits",
  scope_invalid: "Requested Scope is wider than the mounted authority",
  schema_depth_exceeded: "Schema or value exceeds the supported depth",
  state_corrupt: "Knowledge Scope state is corrupt",
  state_capacity_exceeded: "Knowledge Scope state exceeds the local capacity limit",
  state_permissions_invalid: "Knowledge Scope state permissions are unsafe",
  unsupported_schema_keyword: "Schema uses an unsupported keyword",
  value_schema_mismatch: "Value does not match the declared schema",
};

export class KnowledgeScopeProductError extends Error {
  public override readonly name = "KnowledgeScopeProductError";

  public constructor(public readonly code: KnowledgeScopeErrorCode) {
    super(`${code}: ${REDACTED_MESSAGES[code]}`);
  }
}

export const productError = (code: KnowledgeScopeErrorCode): KnowledgeScopeProductError =>
  new KnowledgeScopeProductError(code);
