import { z } from "zod";

import { BoundedJsonValueSchema } from "./bounded-json.js";
import {
  CitationSchema,
  EffectiveScopeSchema,
  KnowledgeScopeIdentifierSchema,
  ProviderScopeSchema,
} from "./knowledge-scope.js";
import { InstallationIdSchema } from "./scalars.js";

export const CapabilityExecutionRequestSchema = z.object({
  installationId: InstallationIdSchema,
  operationId: KnowledgeScopeIdentifierSchema,
  effectiveScope: EffectiveScopeSchema,
  input: BoundedJsonValueSchema,
  filters: z.record(BoundedJsonValueSchema).readonly().optional(),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().readonly();

const ProviderEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("records_operation"), operationId: KnowledgeScopeIdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("open_connector_action"),
    connectorRef: KnowledgeScopeIdentifierSchema,
    actionId: KnowledgeScopeIdentifierSchema,
    connectorRunId: KnowledgeScopeIdentifierSchema,
    actionCorrelationId: KnowledgeScopeIdentifierSchema,
    auditPersisted: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("schift_search"), indexRef: KnowledgeScopeIdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("web_search"), provider: z.enum(["customer", "schift"]),
  }).strict(),
]).readonly();

export const ProviderResultSchema = z.object({
  resultId: KnowledgeScopeIdentifierSchema,
  srn: z.string().regex(/^srn:[a-z0-9][a-z0-9:._/-]+$/).optional(),
  revision: KnowledgeScopeIdentifierSchema,
  freshness: z.string().datetime({ offset: true }).optional(),
  payload: BoundedJsonValueSchema,
  citation: CitationSchema.optional(),
  providerScopes: z.array(ProviderScopeSchema).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Provider scopes must be unique" });
    }
  }).readonly(),
  providerEvidence: ProviderEvidenceSchema,
}).strict().readonly();

const AdmissionReasonSchema = z.enum([
  "installation_not_mounted", "installation_id_mismatch", "definition_digest_mismatch",
  "mount_revision_mismatch", "authorization_decision_untrusted", "scope_authority_mismatch",
  "effective_scope_invalid", "source_binding_not_found", "source_class_mismatch",
  "provider_ref_mismatch", "operation_not_bound", "capability_not_found",
  "permission_mode_unsupported", "permission_mode_mismatch", "source_authority_not_allowed",
  "must_not_use", "context_policy_no_match", "provider_scopes_missing",
  "provider_evidence_mismatch", "connector_ref_mismatch", "connector_action_mismatch",
  "connector_run_missing", "connector_audit_missing",
  "citation_required", "freshness_required", "freshness_in_future", "source_stale",
]);
const AcceptedReceiptSchema = z.object({
  status: z.literal("accepted"), candidateSrn: z.string(),
  matchedPolicy: z.enum(["mustConsider", "mayConsider"]),
  matchedRuleIds: z.array(KnowledgeScopeIdentifierSchema).readonly(),
  authorityRank: z.number().int().nonnegative(),
}).strict();
const DeniedReceiptSchema = z.object({
  status: z.literal("denied"), candidateSrn: z.string(), reasonCode: AdmissionReasonSchema,
}).strict();
export const CandidateAdmissionReceiptSchema = z.discriminatedUnion("status", [
  AcceptedReceiptSchema, DeniedReceiptSchema,
]).readonly();

const RequirementReceiptSchema = z.object({
  requirementId: KnowledgeScopeIdentifierSchema,
  requiredEvidence: z.number().int().positive(),
  observedEvidence: z.number().int().nonnegative(),
  satisfied: z.boolean(),
}).strict().readonly();
export const ScopeRequirementReceiptSchema = z.object({
  status: z.enum(["ready", "insufficient_evidence"]),
  requirements: z.array(RequirementReceiptSchema).readonly(),
  candidateReceipts: z.array(CandidateAdmissionReceiptSchema).readonly(),
}).strict().readonly();

export type CapabilityExecutionRequest = z.infer<typeof CapabilityExecutionRequestSchema>;
export type ProviderResult = z.infer<typeof ProviderResultSchema>;
export type CandidateAdmissionReceipt = z.infer<typeof CandidateAdmissionReceiptSchema>;
export type ScopeRequirementReceipt = z.infer<typeof ScopeRequirementReceiptSchema>;
export type AdmissionDenialReason = z.infer<typeof AdmissionReasonSchema>;
