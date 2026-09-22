import { ScopeAuthoritySchema } from "@schift-io/context-pack";
import { parseSafeBaseUrl } from "./adapters/http-policy.js";
import type { JsonValue } from "./json.js";

export type OnboardingEnvironment = Readonly<Record<string, string | undefined>>;
export class OnboardingError extends Error {
  public override readonly name = "OnboardingError";
  public constructor(public readonly code: string, public readonly details: Readonly<Record<string, JsonValue>> = {}) { super(code); }
}
export const searchConfiguration = (environment: OnboardingEnvironment): readonly string[] => {
  const names = ["SCHIFT_KS_SEARCH_URL", "SCHIFT_KS_SEARCH_TOKEN", "SCHIFT_KS_SEARCH_ORGANIZATION_ID"];
  const issues = names.filter((name) => !environment[name]?.trim());
  const url = environment["SCHIFT_KS_SEARCH_URL"];
  if (url?.trim() && !parseSafeBaseUrl(url).ok) issues.push("SCHIFT_KS_SEARCH_URL");
  const organizationId = environment["SCHIFT_KS_SEARCH_ORGANIZATION_ID"];
  if (organizationId?.trim() && !ScopeAuthoritySchema.safeParse({ organizationId, tenant: "configuration-check" }).success) {
    issues.push("SCHIFT_KS_SEARCH_ORGANIZATION_ID");
  }
  return issues;
};
