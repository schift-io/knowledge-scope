import {
  AuthorizationDecisionSchema,
  CandidateEnvelopeSchema,
  ProviderResultSchema,
  type CandidateEnvelope,
  type CapabilityExecutionRequest,
  type KnowledgeScopeDefinition,
  type KnowledgeScopeMount,
  type QueryCapability,
} from "@schift-io/context-pack";

import { AuthorizationSubjectSchema, type KnowledgeScopeAuthorization } from "./authorization.js";
import { productError } from "./errors.js";
import { canonicalJson, type JsonValue } from "./json.js";
import { GLOBAL_MAX_RESULT_BYTES, GLOBAL_MAX_RESULT_ROWS, type ExecutionBudget } from "./limits.js";
import { compileSchemaSubset, type SchemaValidationResult } from "./schema-subset.js";
import type { StoredKnowledgeScope } from "./state-contract.js";

type SourceBinding = KnowledgeScopeMount["sourceBindings"][number];
type Selector = KnowledgeScopeDefinition["contextPolicy"]["mustConsider"][number]["selector"];
type SchemaValidator = (value: JsonValue) => SchemaValidationResult;

export type ProviderExecutionContext = Readonly<{
  definition: KnowledgeScopeDefinition;
  mount: KnowledgeScopeMount;
  capability: QueryCapability;
  binding: SourceBinding;
  request: CapabilityExecutionRequest;
  validateInput: SchemaValidator;
  validateResult: SchemaValidator;
}>;

export interface ProviderExecutionPort {
  execute(context: ProviderExecutionContext): Promise<readonly unknown[]>;
}

export type PreparedExecution = Readonly<{
  budget?: ExecutionBudget;
  capability: QueryCapability;
  bindings: readonly SourceBinding[];
  validateInput: SchemaValidator;
  validateResult: SchemaValidator;
}>;

const isNarrowedScope = (
  scope: CapabilityExecutionRequest["effectiveScope"],
  mount: KnowledgeScopeMount,
): boolean => scope.tenant === mount.scopeAuthority.tenant &&
  (scope.subject === undefined || scope.namespace !== undefined) &&
  (scope.session === undefined || scope.subject !== undefined);

const matchesSelector = (selector: Selector, binding: SourceBinding): boolean =>
  (selector.sourceIds === undefined || selector.sourceIds.includes(binding.sourceId)) &&
  (selector.sourceClasses === undefined || selector.sourceClasses.includes(binding.sourceClass)) &&
  (selector.authorities === undefined || selector.authorities.includes(binding.authority)) &&
  (selector.origins === undefined || (binding.origin !== undefined && selector.origins.includes(binding.origin)));

const eligibleBinding = (definition: KnowledgeScopeDefinition, binding: SourceBinding): boolean =>
  binding.permissionMode !== "unsupported" && definition.authority.precedence.includes(binding.authority) &&
  !definition.contextPolicy.mustNotUse.some((rule) => matchesSelector(rule.selector, binding)) &&
  [...definition.contextPolicy.mustConsider, ...(definition.contextPolicy.mayConsider ?? [])]
    .some((rule) => matchesSelector(rule.selector, binding));

export const prepareExecution = (
  stored: StoredKnowledgeScope,
  request: CapabilityExecutionRequest,
): PreparedExecution => {
  if (stored.mount.state !== "mounted") throw productError("installation_not_mounted");
  if (request.expectedRevision !== undefined && request.expectedRevision !== stored.mount.revision) {
    throw productError("mount_conflict");
  }
  if (!isNarrowedScope(request.effectiveScope, stored.mount)) throw productError("scope_invalid");
  const capability = stored.definition.capabilities.find((item) => item.operationId === request.operationId);
  if (capability === undefined) throw productError("capability_not_found");
  const inputSchema = stored.files[capability.inputSchemaRef];
  const resultSchema = stored.files[capability.resultSchemaRef];
  if (inputSchema === undefined || resultSchema === undefined) throw productError("state_corrupt");
  const validateInput = compileSchemaSubset(inputSchema);
  const validateResult = compileSchemaSubset(resultSchema);
  if (!validateInput(request.input).valid) throw productError("value_schema_mismatch");
  const allowed = new Set(capability.allowedFilters ?? []);
  if (Object.keys(request.filters ?? {}).some((key) => !allowed.has(key))) {
    throw productError("value_schema_mismatch");
  }
  const bindings = stored.mount.sourceBindings.filter((binding) =>
    binding.operationIds.includes(request.operationId) && eligibleBinding(stored.definition, binding));
  if (bindings.length === 0) throw productError("operation_not_bound");
  return { capability, bindings, validateInput, validateResult };
};

export const executeAndNormalize = async (
  provider: ProviderExecutionPort,
  authorization: KnowledgeScopeAuthorization,
  stored: StoredKnowledgeScope,
  request: CapabilityExecutionRequest,
  prepared: PreparedExecution,
): Promise<readonly CandidateEnvelope[]> => {
  const maxRows = Math.min(prepared.capability.limits?.maxRows ?? GLOBAL_MAX_RESULT_ROWS, GLOBAL_MAX_RESULT_ROWS);
  const entries: Array<Readonly<{ binding: SourceBinding; value: unknown }>> = [];
  for (const binding of prepared.bindings) {
    const results = await provider.execute({
      definition: stored.definition, mount: stored.mount, capability: prepared.capability,
      binding, request, validateInput: prepared.validateInput, validateResult: prepared.validateResult,
    });
    for (const value of results) {
      entries.push({ binding, value });
      if (entries.length > maxRows) throw productError("result_limits_exceeded");
    }
  }
  const parsed = entries.map((entry) => {
    const result = ProviderResultSchema.safeParse(entry.value);
    if (!result.success || !prepared.validateResult(result.data.payload).valid) {
      throw productError("provider_result_invalid");
    }
    return { binding: entry.binding, result: result.data };
  });
  const bytes = parsed.reduce((total, entry) =>
    total + new TextEncoder().encode(canonicalJson(entry.result)).byteLength, 0);
  const maxBytes = Math.min(
    prepared.capability.limits?.maxResultBytes ?? GLOBAL_MAX_RESULT_BYTES,
    GLOBAL_MAX_RESULT_BYTES,
  );
  if (bytes > maxBytes) {
    throw productError("result_limits_exceeded");
  }
  prepared.budget?.consume(parsed.length, bytes);
  return Promise.all(parsed.map(async ({ binding, result }) => {
    if (binding.permissionMode === "unsupported") throw productError("operation_not_bound");
    const srn = result.srn ?? `srn:${binding.sourceId}:${result.resultId}`;
    const permission = `mount:${stored.mount.revision}:${binding.sourceId}:${binding.permissionMode}`;
    const subject = AuthorizationSubjectSchema.parse({
      srn,
      sourceId: binding.sourceId,
      sourceClass: binding.sourceClass,
      providerRef: binding.providerRef,
      installationId: stored.mount.installationId, definitionDigest: stored.mount.definitionDigest,
      mountRevision: stored.mount.revision, operationId: request.operationId,
      scopeAuthority: stored.mount.scopeAuthority, effectiveScope: request.effectiveScope,
      revision: result.revision, permission, permissionMode: binding.permissionMode,
      providerScopes: result.providerScopes, providerEvidence: result.providerEvidence,
      ...(result.freshness === undefined ? {} : { freshness: result.freshness }),
      payload: result.payload, ...(result.citation === undefined ? {} : { citation: result.citation }),
    });
    const authorizationDecision = AuthorizationDecisionSchema.parse(await authorization.issue(subject));
    return CandidateEnvelopeSchema.parse({
      ...subject, authorizationDecision,
    });
  }));
};
