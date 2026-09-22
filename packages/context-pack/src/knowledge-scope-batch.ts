import { z } from "zod";
import { CapabilityExecutionRequestSchema } from "./knowledge-scope-execution.js";

export const CapabilityBatchOperationSchema = z.object({
  operationId: CapabilityExecutionRequestSchema.unwrap().shape.operationId,
  input: CapabilityExecutionRequestSchema.unwrap().shape.input,
  filters: CapabilityExecutionRequestSchema.unwrap().shape.filters,
}).strict().readonly();

export const CapabilityBatchExecutionRequestSchema = z.object({
  installationId: CapabilityExecutionRequestSchema.unwrap().shape.installationId,
  effectiveScope: CapabilityExecutionRequestSchema.unwrap().shape.effectiveScope,
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  operations: z.array(CapabilityBatchOperationSchema).min(1).max(8).superRefine((operations, context) => {
    if (new Set(operations.map((operation) => operation.operationId)).size !== operations.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Batch operation IDs must be unique" });
    }
  }).readonly(),
}).strict().readonly();

export type CapabilityBatchOperation = z.infer<typeof CapabilityBatchOperationSchema>;
export type CapabilityBatchExecutionRequest = z.infer<typeof CapabilityBatchExecutionRequestSchema>;
