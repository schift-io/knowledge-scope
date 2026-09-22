import { z } from "zod"

import { KnowledgeScopeProductError } from "../errors.js"
import { parseJsonText, type JsonValue } from "../json.js"
import { failure, GLOBAL_MAX_RESULT_BYTES } from "./gates.js"
import type { AdapterFailure, HttpResponseLike } from "./types.js"

export type ParsedResponse =
  | Readonly<{ ok: true; value: JsonValue }>
  | Readonly<{ ok: false; error: AdapterFailure }>

const readBoundedText = async (
  response: HttpResponseLike,
  maxBytes: number,
): Promise<Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; error: AdapterFailure }>> => {
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return { ok: false, error: failure("response_too_large", "Provider response exceeds the declared byte limit") }
    }
  }
  if (response.body === null) return { ok: true, text: "" }
  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let totalBytes = 0
  let text = ""
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      totalBytes += result.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        return { ok: false, error: failure("response_too_large", "Provider response exceeds the declared byte limit") }
      }
      text += decoder.decode(result.value, { stream: true })
    }
    text += decoder.decode()
    return { ok: true, text }
  } catch (error) {
    if (error instanceof TypeError) {
      return { ok: false, error: failure("provider_response_malformed", "Provider response is not valid UTF-8") }
    }
    throw error
  } finally {
    reader.releaseLock()
  }
}

export const readProviderResponse = async (
  response: HttpResponseLike,
  maxBytes: number | undefined,
): Promise<ParsedResponse> => {
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: failure("provider_rejected", "Provider rejected the operation") }
  }
  const effectiveMaxBytes = Math.min(maxBytes ?? GLOBAL_MAX_RESULT_BYTES, GLOBAL_MAX_RESULT_BYTES)
  const bounded = await readBoundedText(response, effectiveMaxBytes)
  if (!bounded.ok) return bounded
  try {
    return { ok: true, value: parseJsonText(bounded.text, "provider response") }
  } catch (error) {
    if (error instanceof KnowledgeScopeProductError) {
      return { ok: false, error: failure("provider_response_malformed", "Provider response is not valid JSON") }
    }
    throw error
  }
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
)
