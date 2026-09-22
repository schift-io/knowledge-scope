import { z } from "zod";
import {
  CandidateEnvelopeSchema, CapabilityBatchExecutionRequestSchema, CapabilityExecutionRequestSchema, InstallationIdSchema,
  KnowledgeScopeDefinitionSchema, KnowledgeScopeLockSchema, KnowledgeScopeMountSchema,
  ScopeRequirementReceiptSchema, digestCanonicalJson, digestKnowledgeScopeDefinition,
  materializeKnowledgeScopePack,
} from "@schift-io/context-pack";
import type { KnowledgeScopeApplicationPort, RunApplicationRequest, RunBatchApplicationRequest } from "./api.js";
import type { KnowledgeScopeInspection, KnowledgeScopeRunResult } from "./application.js";
import { MAX_CANDIDATES } from "./limits.js";
import { canonicalJson } from "./json.js";
import { parseJsonText } from "./json.js";
import { validateClientReceipt, validateClientCandidates } from "./client-validation.js";

import { KnowledgeScopeClientError } from "./client-error.js";
export { KnowledgeScopeClientError } from "./client-error.js";

const InspectionSchema = z.object({ definition: KnowledgeScopeDefinitionSchema,
  lock: KnowledgeScopeLockSchema, mount: KnowledgeScopeMountSchema }).strict().readonly();
const RunResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), candidates: z.array(CandidateEnvelopeSchema).min(1).max(MAX_CANDIDATES).readonly(),
    receipt: ScopeRequirementReceiptSchema }).strict(),
  z.object({ status: z.literal("insufficient_evidence"), candidates: z.tuple([]).readonly(),
    receipt: ScopeRequirementReceiptSchema }).strict(),
]).readonly();
const AdmitRequestSchema = z.object({ installationId: InstallationIdSchema,
  candidates: z.array(CandidateEnvelopeSchema).min(1).max(MAX_CANDIDATES).readonly() }).strict();

export type KnowledgeScopeClient = Readonly<{
  inspect: (installationId: string) => Promise<KnowledgeScopeInspection>;
  run: (request: RunApplicationRequest) => Promise<KnowledgeScopeRunResult>;
  runBatch: (request: RunBatchApplicationRequest) => Promise<KnowledgeScopeRunResult>;
  admit: (request: Readonly<{ installationId: string; candidates: readonly unknown[] }>) => Promise<z.infer<typeof ScopeRequirementReceiptSchema>>;
}>;

/** The injected application owns authorization; this boundary checks wire integrity, not its HMAC key. */
export const createKnowledgeScopeClient = (
  options: Readonly<{ application: KnowledgeScopeApplicationPort }>,
): KnowledgeScopeClient => {
  const inspect = async (installationId: string): Promise<KnowledgeScopeInspection> => {
    if (!InstallationIdSchema.safeParse(installationId).success) throw new KnowledgeScopeClientError("request_invalid");
    const parsed = InspectionSchema.safeParse(await options.application.inspect(installationId));
    if (!parsed.success) throw new KnowledgeScopeClientError("response_invalid");
    const { definition, lock, mount } = parsed.data;
    const { lockDigest, ...projection } = lock;
    const paths = ["scope.json", ...new Set(definition.capabilities.flatMap((item) =>
      [item.inputSchemaRef, item.resultSchemaRef]))].sort();
    if (mount.installationId !== installationId || mount.definitionDigest !== lock.definitionDigest ||
      lock.definitionDigest !== await digestKnowledgeScopeDefinition(definition) ||
      lock.packId !== definition.packId || lock.version !== definition.version ||
      canonicalJson(lock.files.map((file) => file.path)) !== canonicalJson(paths) ||
      lock.files.find((file) => file.path === "scope.json")?.digest !== lock.definitionDigest ||
      lockDigest !== await digestCanonicalJson(projection)) throw new KnowledgeScopeClientError("identity_mismatch");
    try { materializeKnowledgeScopePack(definition, mount); }
    catch { throw new KnowledgeScopeClientError("response_invalid"); }
    return parsed.data;
  };
  return {
    inspect,
    run: async (rawRequest) => {
      const request = CapabilityExecutionRequestSchema.safeParse(rawRequest);
      if (!request.success) throw new KnowledgeScopeClientError("request_invalid");
      const inspection = await inspect(request.data.installationId);
      if (inspection.mount.state !== "mounted" ||
        inspection.mount.scopeAuthority.tenant !== request.data.effectiveScope.tenant ||
        (request.data.expectedRevision !== undefined && request.data.expectedRevision !== inspection.mount.revision) ||
        !inspection.definition.capabilities.some((item) => item.operationId === request.data.operationId)) {
        throw new KnowledgeScopeClientError("identity_mismatch");
      }
      const response = RunResultSchema.safeParse(await options.application.run({ ...rawRequest,
        expectedRevision: inspection.mount.revision }));
      if (!response.success) throw new KnowledgeScopeClientError("response_invalid");
      const result = response.data;
      if (result.status !== result.receipt.status) throw new KnowledgeScopeClientError("response_invalid");
      validateClientReceipt(result.receipt, inspection);
      validateClientCandidates({ inspection, candidates: result.candidates, receipt: result.receipt });
      for (const candidate of result.candidates) {
        if (candidate.operationId !== request.data.operationId ||
          canonicalJson(candidate.effectiveScope) !== canonicalJson(request.data.effectiveScope)) {
          throw new KnowledgeScopeClientError("identity_mismatch");
        }
      }
      switch (result.status) {
        case "ready": return result;
        case "insufficient_evidence": return { status: result.status, receipt: result.receipt, candidates: [] };
      }
    },
    runBatch: async (rawRequest) => {
      const request = CapabilityBatchExecutionRequestSchema.safeParse(rawRequest);
      if (!request.success) throw new KnowledgeScopeClientError("request_invalid");
      if (options.application.runBatch === undefined) throw new KnowledgeScopeClientError("batch_unsupported");
      const inspection = await inspect(request.data.installationId);
      const operationIds = new Set(request.data.operations.map((item) => item.operationId));
      if (inspection.mount.state !== "mounted" ||
        inspection.mount.scopeAuthority.tenant !== request.data.effectiveScope.tenant ||
        (request.data.expectedRevision !== undefined && request.data.expectedRevision !== inspection.mount.revision) ||
        request.data.operations.some((operation) => !inspection.definition.capabilities.some((item) => item.operationId === operation.operationId))) {
        throw new KnowledgeScopeClientError("identity_mismatch");
      }
      const response = RunResultSchema.safeParse(await options.application.runBatch({ ...request.data,
        expectedRevision: inspection.mount.revision }));
      if (!response.success) throw new KnowledgeScopeClientError("response_invalid");
      const result = response.data;
      if (result.status !== result.receipt.status) throw new KnowledgeScopeClientError("response_invalid");
      validateClientReceipt(result.receipt, inspection);
      for (const candidate of result.candidates) {
        if (!operationIds.has(candidate.operationId) ||
          canonicalJson(candidate.effectiveScope) !== canonicalJson(request.data.effectiveScope)) {
          throw new KnowledgeScopeClientError("identity_mismatch");
        }
      }
      validateClientCandidates({ inspection, candidates: result.candidates, receipt: result.receipt });
      switch (result.status) {
        case "ready": {
          const represented = new Set(result.candidates.map((candidate) => candidate.operationId));
          if (represented.size !== operationIds.size || result.receipt.candidateReceipts.some((receipt) => receipt.status === "denied")) {
            throw new KnowledgeScopeClientError("response_invalid");
          }
          return result;
        }
        case "insufficient_evidence": return { status: result.status, receipt: result.receipt, candidates: [] };
      }
    },
    admit: async (rawRequest) => {
      const request = AdmitRequestSchema.safeParse(rawRequest);
      if (!request.success) throw new KnowledgeScopeClientError("request_invalid");
      const inspection = await inspect(request.data.installationId);
      const parsed = ScopeRequirementReceiptSchema.safeParse(await options.application.admit({
        installationId: request.data.installationId,
        candidates: request.data.candidates.map((candidate) => parseJsonText(JSON.stringify(candidate), "candidate")),
      }));
      if (!parsed.success || parsed.data.candidateReceipts.length !== request.data.candidates.length ||
        parsed.data.candidateReceipts.some((receipt, index) => receipt.candidateSrn !== request.data.candidates[index]?.srn)) {
        throw new KnowledgeScopeClientError("response_invalid");
      }
      validateClientReceipt(parsed.data, inspection);
      const accepted = request.data.candidates.filter((_candidate, index) => parsed.data.candidateReceipts[index]?.status === "accepted");
      validateClientCandidates({ inspection, candidates: accepted, receipt: parsed.data });
      return parsed.data;
    },
  };
};
