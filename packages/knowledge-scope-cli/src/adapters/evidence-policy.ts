import type { AdapterFailure, CitationFact } from "./types.js"
import { failure } from "./gates.js"

const CITATION_SCHEMES = new Set(["https:", "schift:"])
const FUTURE_SKEW_MILLISECONDS = 60_000

export const validateCitation = (citation: CitationFact): AdapterFailure | undefined => {
  let url: URL
  try {
    url = new URL(citation.uri)
  } catch (error) {
    if (error instanceof TypeError) {
      return failure("unsafe_citation", "Citation URI is invalid")
    }
    throw error
  }
  if (
    !CITATION_SCHEMES.has(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    citation.label === ""
  ) {
    return failure("unsafe_citation", "Citation URI or label is unsafe")
  }
  return undefined
}

export const validateFreshness = (
  freshness: string,
  now: Date,
  maxAgeSeconds: number | undefined,
): AdapterFailure | undefined => {
  const timestamp = Date.parse(freshness)
  if (!Number.isFinite(timestamp) || timestamp > now.getTime() + FUTURE_SKEW_MILLISECONDS) {
    return failure("invalid_freshness", "Provider freshness timestamp is invalid")
  }
  if (maxAgeSeconds !== undefined && now.getTime() - timestamp > maxAgeSeconds * 1_000) {
    return failure("result_stale", "Provider result exceeds the declared freshness limit")
  }
  return undefined
}
