import { KnowledgeScopeMountSchema } from "@schift-io/context-pack";
import { z } from "zod";
import type { KnowledgeScopeApplicationPort } from "./api.js";
import type { JsonValue } from "./json.js";
import { OnboardingError } from "./onboarding-config.js";

export const queryProject = async (
  request: Readonly<{ installationId: string; query: string }>,
  application: KnowledgeScopeApplicationPort,
): Promise<JsonValue> => {
  if (request.query.trim().length === 0 || request.query.length > 8192) throw new OnboardingError("argument_invalid");
  const { mount } = z.object({ mount: KnowledgeScopeMountSchema }).parse(await application.inspect(request.installationId));
  if (mount.installationId !== request.installationId) throw new OnboardingError("installation_mismatch");
  return application.run({ installationId: mount.installationId, operationId: "search",
    effectiveScope: { tenant: mount.scopeAuthority.tenant }, expectedRevision: mount.revision, input: { query: request.query } });
};
