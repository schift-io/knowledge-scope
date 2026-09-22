import { Sha256DigestSchema } from "./scalars.js";
import type { Sha256Digest } from "./scalars.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  public readonly value: JsonValue;

  public constructor(message: string, value: JsonValue) {
    super(message);
    this.name = "CanonicalJsonError";
    this.value = value;
  }
}

const serializeScalar = (value: JsonPrimitive): string => {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CanonicalJsonError("Canonical JSON requires finite numbers", value);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new CanonicalJsonError("Value cannot be represented as JSON", value);
  }
  return serialized;
};

const compareUtf16CodeUnits = (left: string, right: string): number => {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

export const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return serializeScalar(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareUtf16CodeUnits(left, right));
  const serialized = entries.map(
    ([key, entry]) => `${serializeScalar(key)}:${canonicalJson(entry)}`,
  );
  return `{${serialized.join(",")}}`;
};

export const digestCanonicalJson = async (value: JsonValue): Promise<Sha256Digest> => {
  const content = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", content);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return Sha256DigestSchema.parse(`sha256:${hex}`);
};
