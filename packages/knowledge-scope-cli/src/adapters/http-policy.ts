import type { AdapterFailure } from "./types.js"
import { failure } from "./gates.js"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

export type SafeBaseUrlResult =
  | Readonly<{ ok: true; url: URL }>
  | Readonly<{ ok: false; error: AdapterFailure }>

export const parseSafeBaseUrl = (value: string): SafeBaseUrlResult => {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    if (error instanceof TypeError) {
      return { ok: false, error: failure("invalid_url", "Provider base URL is invalid") }
    }
    throw error
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return { ok: false, error: failure("invalid_url", "Provider URL cannot contain credentials or a fragment") }
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return { ok: false, error: failure("invalid_url", "Provider URL must use HTTPS or loopback HTTP") }
  }
  return { ok: true, url }
}

export const requestSignal = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}
