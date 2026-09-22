import { productError } from "./errors.js";
import { canonicalJson, type JsonValue } from "./json.js";

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);
const SUPPORTED_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

export type SchemaValidationResult =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; path: string; reason: string }>;

type SchemaNode = Readonly<{
  type?: string;
  properties?: Readonly<Record<string, SchemaNode>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
  enum?: readonly JsonValue[];
  const?: JsonValue;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const optionalInteger = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw productError("unsupported_schema_keyword");
  }
  return value;
};

const optionalNumber = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw productError("unsupported_schema_keyword");
  }
  return value;
};

const parseSchema = (value: unknown, depth: number): SchemaNode => {
  if (depth > 16) throw productError("schema_depth_exceeded");
  if (!isRecord(value)) throw productError("unsupported_schema_keyword");
  for (const keyword of Object.keys(value)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) throw productError("unsupported_schema_keyword");
  }
  const rawType = value["type"];
  if (rawType !== undefined && (typeof rawType !== "string" || !SUPPORTED_TYPES.has(rawType))) {
    throw productError("unsupported_schema_keyword");
  }
  const rawProperties = value["properties"];
  let properties: Readonly<Record<string, SchemaNode>> | undefined;
  if (rawProperties !== undefined) {
    if (!isRecord(rawProperties)) throw productError("unsupported_schema_keyword");
    properties = Object.fromEntries(
      Object.entries(rawProperties).map(([key, child]) => [key, parseSchema(child, depth + 1)]),
    );
  }
  const rawRequired = value["required"];
  let required: readonly string[] | undefined;
  if (rawRequired !== undefined) {
    if (!Array.isArray(rawRequired) || !rawRequired.every((item) => typeof item === "string")) {
      throw productError("unsupported_schema_keyword");
    }
    if (new Set(rawRequired).size !== rawRequired.length) throw productError("unsupported_schema_keyword");
    required = rawRequired;
  }
  const rawAdditional = value["additionalProperties"];
  if (rawAdditional !== undefined && typeof rawAdditional !== "boolean") {
    throw productError("unsupported_schema_keyword");
  }
  const rawItems = value["items"];
  const rawEnum = value["enum"];
  if (rawEnum !== undefined && (!Array.isArray(rawEnum) || !rawEnum.every(isJsonValue))) {
    throw productError("unsupported_schema_keyword");
  }
  const rawConst = value["const"];
  if (rawConst !== undefined && !isJsonValue(rawConst)) throw productError("unsupported_schema_keyword");
  const minLength = optionalInteger(value["minLength"]);
  const maxLength = optionalInteger(value["maxLength"]);
  const minimum = optionalNumber(value["minimum"]);
  const maximum = optionalNumber(value["maximum"]);
  const minItems = optionalInteger(value["minItems"]);
  const maxItems = optionalInteger(value["maxItems"]);
  if (
    (minLength !== undefined && maxLength !== undefined && minLength > maxLength) ||
    (minimum !== undefined && maximum !== undefined && minimum > maximum) ||
    (minItems !== undefined && maxItems !== undefined && minItems > maxItems)
  ) {
    throw productError("unsupported_schema_keyword");
  }
  return {
    ...(rawType === undefined ? {} : { type: rawType }),
    ...(properties === undefined ? {} : { properties }),
    ...(required === undefined ? {} : { required }),
    ...(rawAdditional === undefined ? {} : { additionalProperties: rawAdditional }),
    ...(rawItems === undefined ? {} : { items: parseSchema(rawItems, depth + 1) }),
    ...(rawEnum === undefined ? {} : { enum: rawEnum }),
    ...(rawConst === undefined ? {} : { const: rawConst }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
  };
};

const mismatch = (path: string, reason: string): SchemaValidationResult => ({ valid: false, path, reason });

const matchesType = (type: string, value: JsonValue): boolean => {
  switch (type) {
    case "array": return Array.isArray(value);
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "null": return value === null;
    case "number": return typeof value === "number";
    case "object": return isRecord(value);
    case "string": return typeof value === "string";
    default: throw productError("unsupported_schema_keyword");
  }
};

const validateNode = (schema: SchemaNode, value: JsonValue, path: string, depth: number): SchemaValidationResult => {
  if (depth > 16) throw productError("schema_depth_exceeded");
  if (schema.type !== undefined && !matchesType(schema.type, value)) return mismatch(path, "type");
  if (schema.enum !== undefined && !schema.enum.some((entry) => canonicalJson(entry) === canonicalJson(value))) {
    return mismatch(path, "enum");
  }
  if (schema.const !== undefined && canonicalJson(schema.const) !== canonicalJson(value)) return mismatch(path, "const");
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return mismatch(path, "minLength");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return mismatch(path, "maxLength");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return mismatch(path, "minimum");
    if (schema.maximum !== undefined && value > schema.maximum) return mismatch(path, "maximum");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return mismatch(path, "minItems");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return mismatch(path, "maxItems");
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        const result = validateNode(schema.items, item, `${path}[${index}]`, depth + 1);
        if (!result.valid) return result;
      }
    }
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return mismatch(`${path}.${key}`, "required");
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const entry = value[key];
      if (entry !== undefined) {
        const result = validateNode(child, entry, `${path}.${key}`, depth + 1);
        if (!result.valid) return result;
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      const extra = Object.keys(value).find((key) => !known.has(key));
      if (extra !== undefined) return mismatch(`${path}.${extra}`, "additionalProperties");
    }
  }
  return { valid: true };
};

const assertValueDepth = (value: JsonValue, depth: number): void => {
  if (depth > 16) throw productError("schema_depth_exceeded");
  if (Array.isArray(value)) {
    for (const item of value) assertValueDepth(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      if (isJsonValue(item)) assertValueDepth(item, depth + 1);
    }
  }
};

export const compileSchemaSubset = (rawSchema: unknown): ((value: JsonValue) => SchemaValidationResult) => {
  const schema = parseSchema(rawSchema, 0);
  return (value) => {
    assertValueDepth(value, 0);
    return validateNode(schema, value, "$", 0);
  };
};
