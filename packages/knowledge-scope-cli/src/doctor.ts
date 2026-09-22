import { KnowledgeScopeDefinitionSchema, KnowledgeScopeLockSchema, KnowledgeScopeMountSchema, digestKnowledgeScopeDefinition } from "@schift-io/context-pack";
import { z } from "zod";
import type { KnowledgeScopeApplicationPort } from "./api.js";
import type { JsonValue } from "./json.js";
import { OnboardingError, type OnboardingEnvironment } from "./onboarding-config.js";
import { doctorConfiguration } from "./doctor-config.js";

const InspectionSchema = z.object({ definition: KnowledgeScopeDefinitionSchema, lock: KnowledgeScopeLockSchema, mount: KnowledgeScopeMountSchema });
export const doctor = async (
  request: Readonly<{ installationId: string; query?: string }>,
  application: KnowledgeScopeApplicationPort,
  environment: OnboardingEnvironment,
): Promise<JsonValue> => {
  if (request.query !== undefined && (request.query.trim().length === 0 || request.query.length > 8192)) throw new OnboardingError("argument_invalid");
  const inspection = InspectionSchema.parse(await application.inspect(request.installationId));
  const { definition, lock, mount } = inspection;
  const digest = await digestKnowledgeScopeDefinition(definition);
  const integrity = lock.definitionDigest === digest && mount.definitionDigest === digest && mount.installationId === request.installationId;
  const issues = doctorConfiguration(inspection, environment);
  const configured = integrity && mount.state === "mounted" && issues.length === 0;
  const report = { installationId: mount.installationId, integrity, state: mount.state, environment: [...new Set(issues)], configured };
  if (request.query === undefined) return { ...report, status: configured ? "configured" : "attention_required", evidenceVerified: false };
  if (!configured) throw new OnboardingError("configuration_invalid", { ...report });
  const capability = definition.capabilities.find((entry) =>
    (entry.provider.kind === "schift_search" || entry.provider.kind === "local_documents") &&
    mount.sourceBindings.some((binding) => binding.operationIds.includes(entry.operationId)));
  if (capability === undefined) throw new OnboardingError("probe_operation_unavailable");
  const result = await application.run({ installationId: mount.installationId, operationId: capability.operationId, effectiveScope: { tenant: mount.scopeAuthority.tenant }, expectedRevision: mount.revision, input: { query: request.query } });
  return { ...report, status: "probed", result };
};
