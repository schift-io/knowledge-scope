import { z } from "zod";

import type { JsonValue } from "./canonical.js";

const JSON_MAX_DEPTH = 16;
const JSON_MAX_NODES = 4_096;
const JSON_MAX_STRING_LENGTH = 65_536;
const UTF8_ENCODER = new TextEncoder();
const isBoundedText = (value: string): boolean =>
  UTF8_ENCODER.encode(value).byteLength <= JSON_MAX_STRING_LENGTH;
const isPortableJsonNumber = (value: number): boolean =>
  !Number.isInteger(value) || Number.isSafeInteger(value);

const createJsonValueSchema = (remainingDepth: number): z.ZodType<JsonValue> => {
  const scalarSchemas = [
    z.null(),
    z.boolean(),
    z.number().finite().refine(
      isPortableJsonNumber,
      "Integral JSON numbers must be safe integers",
    ),
    z.string().refine(isBoundedText, "JSON text exceeds the UTF-8 byte limit"),
  ] as const;
  if (remainingDepth === 0) return z.union(scalarSchemas);
  const child = createJsonValueSchema(remainingDepth - 1);
  const record = z.record(child).superRefine((value, context) => {
    if (Object.keys(value).length > JSON_MAX_NODES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON object exceeds the entry limit" });
    }
  });
  return z.union([...scalarSchemas, z.array(child).max(JSON_MAX_NODES), record]);
};

const JsonValueSchema = createJsonValueSchema(JSON_MAX_DEPTH);

const addJsonBoundsIssues = (value: JsonValue, context: z.RefinementCtx): void => {
  let nodes = 0;
  const visit = (current: JsonValue, depth: number): void => {
    nodes += 1;
    if (nodes > JSON_MAX_NODES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON exceeds the node limit" });
      return;
    }
    if (depth > JSON_MAX_DEPTH) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON exceeds the depth limit" });
      return;
    }
    if (typeof current === "string" && !isBoundedText(current)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON text exceeds the UTF-8 byte limit" });
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (current !== null && typeof current === "object") {
      Object.entries(current).forEach(([key, item]) => {
        if (!isBoundedText(key)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON key exceeds the UTF-8 byte limit" });
        }
        visit(item, depth + 1);
      });
    }
  };
  visit(value, 0);
};

export const BoundedJsonValueSchema = JsonValueSchema.superRefine(addJsonBoundsIssues);
