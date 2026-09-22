import { z } from "zod";

import {
  KnowledgeScopeDefinitionSchema,
  KnowledgeScopeDefinitionBaseSchema,
  KnowledgeScopeIdentifierSchema,
  ScopeAuthoritySchema,
} from "./knowledge-scope.js";
import type { KnowledgeScopeDefinition } from "./knowledge-scope.js";
import type { QueryCapability } from "./knowledge-scope.js";
import { InstallationIdSchema, Sha256DigestSchema, SourceIdSchema } from "./scalars.js";

const SourceBindingSchema = z.object({
  sourceId: SourceIdSchema,
  sourceClass: z.enum(["document", "records", "activity_stream"]),
  providerRef: KnowledgeScopeIdentifierSchema,
  connectorRef: KnowledgeScopeIdentifierSchema.optional(),
  authority: z.enum(["primary", "operational", "approved", "observed", "derived"]),
  origin: z.enum(["observed", "derived"]).optional(),
  permissionMode: z.enum(["live", "mirrored", "static", "unsupported"]),
  operationIds: z.array(KnowledgeScopeIdentifierSchema).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Operation IDs must be unique" });
    }
  }).readonly(),
}).strict().readonly();

export const KnowledgeScopeMountSchema = z.object({
  installationId: InstallationIdSchema,
  definitionDigest: Sha256DigestSchema,
  scopeAuthority: ScopeAuthoritySchema,
  sourceBindings: z.array(SourceBindingSchema).readonly(),
  state: z.enum(["mounted", "unmounted"]),
  revision: z.number().int().positive(),
}).strict().superRefine((mount, context) => {
  const sourceIds = mount.sourceBindings.map((binding) => binding.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Source bindings must be unique" });
  }
  if (mount.state === "mounted" && mount.sourceBindings.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Mounted Scope requires a source binding" });
  }
  if (mount.state === "unmounted" && mount.sourceBindings.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Unmounted Scope cannot retain source bindings" });
  }
}).readonly();

const LegacyScopeSchema = z.object({
  installation: z.literal("required"), root: z.literal("tenant"),
  descendants: z.tuple([z.literal("namespace"), z.literal("subject"), z.literal("session")]).readonly(),
}).strict().readonly();
const LegacyInstallationSchema = z.object({
  mode: z.literal("server_enforced"), state: z.enum(["mounted", "unmounted"]),
  installationId: InstallationIdSchema, packDigest: Sha256DigestSchema,
  scopeAuthority: ScopeAuthoritySchema, sourceBindings: z.array(SourceBindingSchema).readonly(),
}).strict().readonly();

/** @deprecated Use KnowledgeScopeDefinitionSchema and KnowledgeScopeMountSchema. */
export const KnowledgeScopePackSchema = KnowledgeScopeDefinitionBaseSchema.omit({ scope: true }).extend({
  scope: LegacyScopeSchema, installation: LegacyInstallationSchema,
}).strict().superRefine((pack, context) => {
  const known = new Set(pack.capabilities.map((capability) => capability.operationId));
  pack.installation.sourceBindings.forEach((binding, bindingIndex) => {
    binding.operationIds.forEach((operationId, operationIndex) => {
      if (!known.has(operationId)) context.addIssue({ code: z.ZodIssueCode.custom,
        message: "Source binding must reference a declared capability",
        path: ["installation", "sourceBindings", bindingIndex, "operationIds", operationIndex] });
    });
  });
}).readonly();

export type KnowledgeScopeMount = z.infer<typeof KnowledgeScopeMountSchema>;
export type KnowledgeScopePack = z.infer<typeof KnowledgeScopePackSchema>;

export class KnowledgeScopeMaterializationError extends Error {
  public readonly code = "incoherent_source_binding" as const;

  public constructor(message: string) {
    super(message);
    this.name = "KnowledgeScopeMaterializationError";
  }
}

const bindingMatchesCapability = (
  binding: KnowledgeScopeMount["sourceBindings"][number],
  capability: QueryCapability,
): boolean => {
  switch (capability.provider.kind) {
    case "records_operation":
      return binding.providerRef === capability.provider.operationId && binding.connectorRef === undefined;
    case "open_connector_action":
      return binding.providerRef === capability.provider.actionId &&
        binding.connectorRef === capability.provider.connectorRef;
    case "schift_search":
    case "local_documents":
      return binding.providerRef === capability.provider.indexRef && binding.connectorRef === undefined;
    case "web_search":
      return binding.providerRef === capability.provider.provider && binding.connectorRef === undefined;
  }
};

export const materializeKnowledgeScopePack = (
  definition: KnowledgeScopeDefinition,
  mount: KnowledgeScopeMount,
): KnowledgeScopePack => {
  const capabilities = new Map(definition.capabilities.map((capability) => [capability.operationId, capability]));
  for (const binding of mount.sourceBindings) {
    for (const operationId of binding.operationIds) {
      const capability = capabilities.get(operationId);
      if (capability === undefined || !bindingMatchesCapability(binding, capability)) {
        throw new KnowledgeScopeMaterializationError(`Binding ${binding.sourceId} is not coherent with ${operationId}`);
      }
    }
  }
  return KnowledgeScopePackSchema.parse({
    ...definition,
    scope: { installation: "required", ...definition.scope },
    installation: {
      mode: "server_enforced", state: mount.state, installationId: mount.installationId,
      packDigest: mount.definitionDigest, scopeAuthority: mount.scopeAuthority,
      sourceBindings: mount.sourceBindings,
    },
  });
};
