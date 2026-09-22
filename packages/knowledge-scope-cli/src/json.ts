import { productError } from "./errors.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

type Cursor = { index: number; nodes: number };

export const DEFAULT_MAX_JSON_BYTES = 1_048_576;
export const DEFAULT_MAX_JSON_DEPTH = 16;
export const DEFAULT_MAX_JSON_NODES = 100_000;

export const decodeUtf8Strict = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw productError("invalid_json");
    throw error;
  }
};

export type ParseJsonOptions = Readonly<{
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
}>;
type ParseLimits = Readonly<{ maxDepth: number; maxNodes: number }>;

const whitespace = /\s/;
const numberStart = /[-0-9]/;

const skipWhitespace = (text: string, cursor: Cursor): void => {
  while (cursor.index < text.length && whitespace.test(text[cursor.index] ?? "")) {
    cursor.index += 1;
  }
};

const parseString = (text: string, cursor: Cursor): string => {
  const start = cursor.index;
  cursor.index += 1;
  let escaped = false;
  while (cursor.index < text.length) {
    const character = text[cursor.index];
    cursor.index += 1;
    if (character === '"' && !escaped) {
      const token = text.slice(start, cursor.index);
      try {
        const parsed: unknown = JSON.parse(token);
        if (typeof parsed === "string") return parsed;
      } catch (error) {
        if (error instanceof SyntaxError) throw productError("invalid_json");
        throw error;
      }
      throw productError("invalid_json");
    }
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  throw productError("invalid_json");
};

const parseArray = (
  text: string,
  cursor: Cursor,
  depth: number,
  limits: ParseLimits,
): readonly JsonValue[] => {
  cursor.index += 1;
  const values: JsonValue[] = [];
  skipWhitespace(text, cursor);
  if (text[cursor.index] === "]") {
    cursor.index += 1;
    return values;
  }
  while (cursor.index < text.length) {
    values.push(parseValue(text, cursor, depth + 1, limits));
    skipWhitespace(text, cursor);
    const separator = text[cursor.index];
    cursor.index += 1;
    if (separator === "]") return values;
    if (separator !== ",") throw productError("invalid_json");
  }
  throw productError("invalid_json");
};

const parseObject = (text: string, cursor: Cursor, depth: number, limits: ParseLimits): JsonObject => {
  cursor.index += 1;
  const entries: Array<readonly [string, JsonValue]> = [];
  const keys = new Set<string>();
  skipWhitespace(text, cursor);
  if (text[cursor.index] === "}") {
    cursor.index += 1;
    return Object.fromEntries(entries);
  }
  while (cursor.index < text.length) {
    skipWhitespace(text, cursor);
    if (text[cursor.index] !== '"') throw productError("invalid_json");
    const key = parseString(text, cursor);
    if (keys.has(key)) throw productError("duplicate_json_key");
    keys.add(key);
    skipWhitespace(text, cursor);
    if (text[cursor.index] !== ":") throw productError("invalid_json");
    cursor.index += 1;
    entries.push([key, parseValue(text, cursor, depth + 1, limits)]);
    skipWhitespace(text, cursor);
    const separator = text[cursor.index];
    cursor.index += 1;
    if (separator === "}") return Object.fromEntries(entries);
    if (separator !== ",") throw productError("invalid_json");
  }
  throw productError("invalid_json");
};

const parseScalar = (text: string, cursor: Cursor): JsonPrimitive => {
  const remainder = text.slice(cursor.index);
  const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(remainder);
  if (match === null || (!numberStart.test(match[0][0] ?? "") && !/^(?:true|false|null)$/.test(match[0]))) {
    throw productError("invalid_json");
  }
  cursor.index += match[0].length;
  const parsed: unknown = JSON.parse(match[0]);
  if (parsed === null || typeof parsed === "boolean" || typeof parsed === "number") return parsed;
  throw productError("invalid_json");
};

const parseValue = (text: string, cursor: Cursor, depth: number, limits: ParseLimits): JsonValue => {
  cursor.nodes += 1;
  if (depth > limits.maxDepth || cursor.nodes > limits.maxNodes) {
    throw productError("json_limits_exceeded");
  }
  skipWhitespace(text, cursor);
  const character = text[cursor.index];
  if (character === '"') return parseString(text, cursor);
  if (character === "[") return parseArray(text, cursor, depth, limits);
  if (character === "{") return parseObject(text, cursor, depth, limits);
  return parseScalar(text, cursor);
};

export const parseJsonText = (
  text: string,
  _sourceName: string,
  options: ParseJsonOptions = {},
): JsonValue => {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const limits: ParseLimits = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_JSON_DEPTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_JSON_NODES,
  };
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
    !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0 ||
    !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes <= 0 ||
    new TextEncoder().encode(text).byteLength > maxBytes) {
    throw productError("json_limits_exceeded");
  }
  const cursor: Cursor = { index: 0, nodes: 0 };
  const value = parseValue(text, cursor, 0, limits);
  skipWhitespace(text, cursor);
  if (cursor.index !== text.length) throw productError("invalid_json");
  return value;
};

const serializePrimitive = (value: unknown): string => {
  if (value !== null && typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") {
    throw productError("invalid_json");
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw productError("invalid_json");
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw productError("invalid_json");
  return serialized;
};

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return serializePrimitive(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${serializePrimitive(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
};

export const sha256Digest = async (value: JsonValue): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
};
