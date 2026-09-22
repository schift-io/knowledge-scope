import type { KnowledgeScopeDefinition, KnowledgeScopeMount } from "@schift-io/context-pack";
import { z } from "zod";
import { parseSafeBaseUrl } from "./adapters/http-policy.js";
import { searchConfiguration, type OnboardingEnvironment } from "./onboarding-config.js";

const ActionsSchema = z.array(z.object({ connectorRef: z.string().min(1), connectorAlias: z.string().min(1), actionId: z.string().min(1) }).strict()).min(1);
export const doctorConfiguration = (inspection: Readonly<{ definition: KnowledgeScopeDefinition; mount: KnowledgeScopeMount }>, environment: OnboardingEnvironment): readonly string[] => {
  const { definition, mount } = inspection;
  const issues: string[] = [];
  for (const capability of definition.capabilities.filter((entry) => mount.sourceBindings.some((binding) => binding.operationIds.includes(entry.operationId)))) {
    let scopeEnvironment: string | undefined;
    switch (capability.provider.kind) {
      case "local_documents":
        if ((capability.requiredProviderScopes?.length ?? 0) > 0) issues.push("local_documents_provider_scopes_unsupported");
        break;
      case "schift_search":
        issues.push(...searchConfiguration(environment));
        if (environment["SCHIFT_KS_SEARCH_ORGANIZATION_ID"] !== mount.scopeAuthority.organizationId) issues.push("SCHIFT_KS_SEARCH_ORGANIZATION_ID");
        scopeEnvironment = "SCHIFT_KS_SEARCH_SCOPES";
        break;
      case "open_connector_action": {
        const url = environment["SCHIFT_KS_OPEN_CONNECTOR_URL"];
        if (!url || !parseSafeBaseUrl(url).ok) issues.push("SCHIFT_KS_OPEN_CONNECTOR_URL");
        const alias = environment["SCHIFT_KS_OPEN_CONNECTOR_ALIAS"] ?? capability.provider.connectorRef;
        const raw = environment["SCHIFT_KS_OPEN_CONNECTOR_READ_ACTIONS"] ?? "";
        let actions: z.infer<typeof ActionsSchema> = [];
        try { const parsed = ActionsSchema.safeParse(JSON.parse(raw)); if (parsed.success) actions = parsed.data; }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        const provider = capability.provider;
        if (!actions.some((entry) => entry.connectorRef === provider.connectorRef && entry.connectorAlias === alias && entry.actionId === provider.actionId)) issues.push("SCHIFT_KS_OPEN_CONNECTOR_READ_ACTIONS");
        scopeEnvironment = "SCHIFT_KS_OPEN_CONNECTOR_SCOPES";
        break;
      }
      case "records_operation": issues.push("injected_records_executor_required"); break;
      case "web_search": issues.push("web_search_adapter_unavailable"); break;
    }
    if (scopeEnvironment !== undefined) {
      const granted = new Set(environment[scopeEnvironment]?.split(",").map((value) => value.trim()) ?? []);
      if (capability.requiredProviderScopes?.some((scope) => !granted.has(scope))) issues.push(scopeEnvironment);
    }
  }
  return [...new Set(issues)];
};
