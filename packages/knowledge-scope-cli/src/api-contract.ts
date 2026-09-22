import { z } from "zod";
import { MAX_CANDIDATES } from "./application.js";
import { CapabilityBatchExecutionRequestSchema, type CapabilityBatchExecutionRequest } from "@schift-io/context-pack";
import type { JsonValue } from "./json.js";

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(JsonValueSchema), z.record(JsonValueSchema),
]));
export const RemoteMountRequestSchema = z.object({ definition: JsonValueSchema, files: z.record(JsonValueSchema),
  lock: JsonValueSchema, sourceBindings: JsonValueSchema }).strict().readonly();
const MountRequestSchema = z.object({ definition: JsonValueSchema, files: z.record(JsonValueSchema), lock: JsonValueSchema,
  scopeAuthority: JsonValueSchema, sourceBindings: JsonValueSchema }).strict().readonly();
export const RunBodySchema = z.object({ effectiveScope: JsonValueSchema, input: JsonValueSchema,
  filters: JsonValueSchema.optional(), expectedRevision: z.number().int().positive().optional() }).strict().readonly();
export const RunBatchBodySchema = CapabilityBatchExecutionRequestSchema.unwrap().omit({ installationId: true }).readonly();
export const AdmitBodySchema = z.union([z.object({ candidates: z.array(JsonValueSchema).min(1).max(MAX_CANDIDATES).readonly() }).strict().readonly(),
  z.object({ candidate: JsonValueSchema }).strict().readonly()]);
export const UnmountBodySchema = z.object({ expectedRevision: z.number().int().positive() }).strict().readonly();

export type MountApplicationRequest = z.infer<typeof MountRequestSchema>;
export type RunApplicationRequest = Readonly<z.infer<typeof RunBodySchema> & { installationId: string; operationId: string }>;
export type RunBatchApplicationRequest = CapabilityBatchExecutionRequest;
export type AdmitApplicationRequest = Readonly<{ installationId: string; candidates: readonly JsonValue[] }>;
export type UnmountApplicationRequest = Readonly<{ installationId: string; expectedRevision: number }>;

export interface KnowledgeScopeApplicationPort {
  readonly mount: (request: MountApplicationRequest) => Promise<JsonValue>;
  readonly inspect: (installationId: string) => Promise<JsonValue>;
  readonly run: (request: RunApplicationRequest) => Promise<JsonValue>;
  readonly admit: (request: AdmitApplicationRequest) => Promise<JsonValue>;
  readonly unmount: (request: UnmountApplicationRequest) => Promise<JsonValue>;
  readonly runBatch?: (request: RunBatchApplicationRequest) => Promise<JsonValue>;
}
