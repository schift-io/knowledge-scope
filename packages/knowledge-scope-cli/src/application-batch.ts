import type { CandidateEnvelope, CapabilityBatchExecutionRequest, CapabilityExecutionRequest } from "@schift-io/context-pack";
import type { KnowledgeScopeApplicationOptions } from "./application.js";
import { executeAndNormalize, prepareExecution } from "./application-execution.js";
import { ExecutionBudget } from "./limits.js";
import type { StoredKnowledgeScope } from "./state-contract.js";

export const executeBatch = async (
  options: Pick<KnowledgeScopeApplicationOptions, "provider" | "authorization">,
  stored: StoredKnowledgeScope,
  request: CapabilityBatchExecutionRequest,
): Promise<readonly CandidateEnvelope[]> => {
  const budget = new ExecutionBudget();
  // Complete policy, binding, filter and input validation before any provider call.
  const executions = request.operations.map((operation) => {
    const operationRequest: CapabilityExecutionRequest = {
      ...operation,
      installationId: request.installationId,
      effectiveScope: request.effectiveScope,
      ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
    };
    return { request: operationRequest, prepared: { ...prepareExecution(stored, operationRequest), budget } };
  });
  const candidates: CandidateEnvelope[] = [];
  for (const execution of executions) {
    candidates.push(...await executeAndNormalize(
      options.provider, options.authorization, stored, execution.request, execution.prepared,
    ));
  }
  return candidates;
};
