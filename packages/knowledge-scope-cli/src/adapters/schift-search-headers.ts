import type { SchiftSearchRuntime } from "./types.js"

export const searchRequestHeaders = (
  runtime: SchiftSearchRuntime,
): Readonly<Record<string, string>> => ({
  "authorization": `Bearer ${runtime.bearerToken}`,
  "content-type": "application/json",
  "x-org-id": runtime.organizationId,
  "x-schift-client": "knowledge-scope",
  "x-schift-knowledge-scope-organization": runtime.organizationId,
  "x-schift-knowledge-scope-tenant": runtime.tenant,
})
