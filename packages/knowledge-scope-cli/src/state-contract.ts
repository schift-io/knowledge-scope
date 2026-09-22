import { z } from "zod";

import {
  KnowledgeScopeDefinitionSchema,
  KnowledgeScopeLockSchema,
  KnowledgeScopeMountSchema,
} from "@schift-io/context-pack";

import type { JsonValue } from "./json.js";

const StateJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(StateJsonValueSchema),
  z.record(StateJsonValueSchema),
]));

export const StoredKnowledgeScopeSchema = z.object({
  definition: KnowledgeScopeDefinitionSchema,
  lock: KnowledgeScopeLockSchema,
  files: z.record(StateJsonValueSchema).readonly(),
  mount: KnowledgeScopeMountSchema,
}).strict().readonly();

export const KnowledgeScopeStateSchema = z.object({
  schemaVersion: z.literal("knowledge-scope-state.schift.dev/v0.1"),
  revision: z.number().int().nonnegative(),
  installations: z.array(StoredKnowledgeScopeSchema).superRefine((installations, context) => {
    const identifiers = installations.map((entry) => entry.mount.installationId);
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Installation IDs must be unique" });
    }
  }).readonly(),
}).strict().readonly();

export type StoredKnowledgeScope = z.infer<typeof StoredKnowledgeScopeSchema>;
export type KnowledgeScopeState = z.infer<typeof KnowledgeScopeStateSchema>;

export const EMPTY_KNOWLEDGE_SCOPE_STATE: KnowledgeScopeState = {
  schemaVersion: "knowledge-scope-state.schift.dev/v0.1",
  revision: 0,
  installations: [],
};
