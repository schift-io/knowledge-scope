import { z } from "zod";

import { BoundedJsonValueSchema } from "./bounded-json.js";
import { InstallationIdSchema, PackIdSchema, SemanticVersionSchema, Sha256DigestSchema, SourceIdSchema } from "./scalars.js";

export const KnowledgeScopeIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{1,127}$/);
export const ProviderScopeSchema = z.string().regex(/^[a-z][a-z0-9:_.*-]{1,127}$/);
const SchemaReferenceSchema = z.string().min(1).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes("://") &&
  value.split("/").every((component) => component.length > 0 && component !== "." && component !== ".."),
"Schema references must be normalized relative Pack paths");
const uniqueList = <T extends z.ZodTypeAny>(schema: T, label: string) => z.array(schema)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be unique` });
    }
  }).readonly();

const RecordsProviderSchema = z.object({
  kind: z.literal("records_operation"), operationId: KnowledgeScopeIdentifierSchema,
}).strict();
const ConnectorProviderSchema = z.object({
  kind: z.literal("open_connector_action"), actionId: KnowledgeScopeIdentifierSchema,
  connectorRef: KnowledgeScopeIdentifierSchema,
}).strict();
const SearchProviderSchema = z.object({
  kind: z.literal("schift_search"), indexRef: KnowledgeScopeIdentifierSchema,
}).strict();
const WebProviderSchema = z.object({
  kind: z.literal("web_search"), provider: z.enum(["customer", "schift"]),
}).strict();
export const QueryProviderSchema = z.discriminatedUnion("kind", [
  RecordsProviderSchema, ConnectorProviderSchema, SearchProviderSchema, WebProviderSchema,
]).readonly();

export const QueryCapabilitySchema = z.object({
  operationId: KnowledgeScopeIdentifierSchema,
  provider: QueryProviderSchema,
  inputSchemaRef: SchemaReferenceSchema,
  resultSchemaRef: SchemaReferenceSchema,
  allowedFilters: uniqueList(KnowledgeScopeIdentifierSchema, "Filter identifiers").optional(),
  limits: z.object({
    maxRows: z.number().int().positive().optional(), maxResultBytes: z.number().int().positive().optional(),
  }).strict().refine((value) => value.maxRows !== undefined || value.maxResultBytes !== undefined,
    "At least one query limit is required").readonly().optional(),
  freshness: z.object({ maxAgeSeconds: z.number().int().nonnegative() }).strict().readonly().optional(),
  requiredProviderScopes: uniqueList(ProviderScopeSchema, "Provider scopes").optional(),
}).strict().readonly();

const SourceClassSchema = z.enum(["document", "records", "activity_stream"]);
const SourceAuthoritySchema = z.enum(["primary", "operational", "approved", "observed", "derived"]);
const SourceOriginSchema = z.enum(["observed", "derived"]);
const ContextSelectorSchema = z.object({
  sourceIds: uniqueList(KnowledgeScopeIdentifierSchema, "Source identifiers").optional(),
  sourceClasses: uniqueList(SourceClassSchema, "Source classes").optional(),
  authorities: uniqueList(SourceAuthoritySchema, "Authorities").optional(),
  origins: uniqueList(SourceOriginSchema, "Origins").optional(),
}).strict().refine((selector) => [selector.sourceIds, selector.sourceClasses, selector.authorities, selector.origins]
  .some((values) => (values?.length ?? 0) > 0), "Selector requires at least one term").readonly();
const ContextRequirementSchema = z.object({
  id: KnowledgeScopeIdentifierSchema, selector: ContextSelectorSchema,
  minEvidence: z.number().int().positive(), maxAgeSeconds: z.number().int().nonnegative().optional(),
}).strict().readonly();
const ContextDenyRuleSchema = z.object({ id: KnowledgeScopeIdentifierSchema, selector: ContextSelectorSchema })
  .strict().readonly();
const ContextPolicySchema = z.object({
  mustConsider: z.array(ContextRequirementSchema).min(1).readonly(),
  mayConsider: z.array(ContextRequirementSchema).readonly().optional(),
  mustNotUse: z.array(ContextDenyRuleSchema).min(1).readonly(),
}).strict().superRefine((policy, context) => {
  const ids = [...policy.mustConsider, ...(policy.mayConsider ?? []), ...policy.mustNotUse].map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Context policy IDs must be unique" });
}).readonly();

const ScopeSchema = z.object({
  root: z.literal("tenant"),
  descendants: z.tuple([z.literal("namespace"), z.literal("subject"), z.literal("session")]).readonly(),
}).strict().readonly();
const AuthorityPolicySchema = z.object({
  precedence: uniqueList(SourceAuthoritySchema, "Authority precedence"),
  allowed: uniqueList(z.enum(["read", "draft"]), "Allowed authority"),
  forbidden: z.tuple([z.literal("send"), z.literal("approve"), z.literal("mutate_source"), z.literal("workflow")]).readonly(),
}).strict().refine((value) => value.precedence.length > 0 && value.allowed.length > 0,
  "Authority policy lists cannot be empty").readonly();
const EvidencePolicySchema = z.object({
  requireCitation: z.boolean(),
  freshness: z.object({ defaultMaxAgeSeconds: z.number().int().nonnegative() }).strict().readonly(),
  coverageAssertions: uniqueList(KnowledgeScopeIdentifierSchema, "Coverage assertions")
    .refine((values) => values.length > 0, "At least one coverage assertion is required"),
}).strict().readonly();

export const KnowledgeScopeDefinitionBaseSchema = z.object({
  packId: PackIdSchema, version: SemanticVersionSchema,
  responsibility: KnowledgeScopeIdentifierSchema, scope: ScopeSchema,
  capabilities: z.array(QueryCapabilitySchema).readonly(), contextPolicy: ContextPolicySchema,
  authority: AuthorityPolicySchema, evidence: EvidencePolicySchema,
}).strict();
export const KnowledgeScopeDefinitionSchema = KnowledgeScopeDefinitionBaseSchema.superRefine((definition, context) => {
  const operations = definition.capabilities.map((capability) => capability.operationId);
  if (new Set(operations).size !== operations.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Capability operation IDs must be unique" });
  const required = new Set(definition.contextPolicy.mustConsider.map((requirement) => requirement.id));
  definition.evidence.coverageAssertions.forEach((assertion, index) => {
    if (!required.has(assertion)) context.addIssue({ code: z.ZodIssueCode.custom,
      message: "Coverage assertion must name a required Context rule", path: ["evidence", "coverageAssertions", index] });
  });
}).readonly();

export const ScopeAuthoritySchema = z.object({
  organizationId: KnowledgeScopeIdentifierSchema, tenant: KnowledgeScopeIdentifierSchema,
}).strict().readonly();
export const EffectiveScopeSchema = z.object({
  tenant: KnowledgeScopeIdentifierSchema, namespace: KnowledgeScopeIdentifierSchema.optional(),
  subject: KnowledgeScopeIdentifierSchema.optional(), session: KnowledgeScopeIdentifierSchema.optional(),
}).strict().readonly();
export const AuthorizationDecisionSchema = z.object({
  decisionId: KnowledgeScopeIdentifierSchema, decisionDigest: Sha256DigestSchema, status: z.literal("allowed"),
}).strict().readonly();
export const CitationSchema = z.object({
  uri: z.string().regex(/^(?:https|schift):\/\/\S+$/), label: z.string().min(1).optional(),
}).strict().readonly();

const CandidateProviderEvidenceSchema = z.discriminatedUnion("kind", [
  RecordsProviderSchema,
  z.object({ kind: z.literal("open_connector_action"), connectorRef: KnowledgeScopeIdentifierSchema,
    actionId: KnowledgeScopeIdentifierSchema, connectorRunId: KnowledgeScopeIdentifierSchema,
    actionCorrelationId: KnowledgeScopeIdentifierSchema, auditPersisted: z.boolean() }).strict(),
  SearchProviderSchema, WebProviderSchema,
]).readonly();
export const CandidateEnvelopeSchema = z.object({
  srn: z.string().regex(/^srn:[a-z0-9][a-z0-9:._/-]+$/), sourceId: SourceIdSchema,
  sourceClass: SourceClassSchema, providerRef: KnowledgeScopeIdentifierSchema,
  installationId: InstallationIdSchema, definitionDigest: Sha256DigestSchema,
  mountRevision: z.number().int().positive(), operationId: KnowledgeScopeIdentifierSchema,
  scopeAuthority: ScopeAuthoritySchema, effectiveScope: EffectiveScopeSchema,
  authorizationDecision: AuthorizationDecisionSchema, revision: KnowledgeScopeIdentifierSchema,
  permission: z.string().min(1), permissionMode: z.enum(["live", "mirrored", "static"]),
  providerScopes: uniqueList(ProviderScopeSchema, "Provider scopes"), providerEvidence: CandidateProviderEvidenceSchema,
  freshness: z.string().datetime({ offset: true }).optional(), payload: BoundedJsonValueSchema,
  citation: CitationSchema.optional(),
}).strict().readonly();

export type QueryProvider = z.infer<typeof QueryProviderSchema>;
export type QueryCapability = z.infer<typeof QueryCapabilitySchema>;
export type KnowledgeScopeDefinition = z.infer<typeof KnowledgeScopeDefinitionSchema>;
export type CandidateEnvelope = z.infer<typeof CandidateEnvelopeSchema>;
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;
