import { createHash } from "node:crypto"

import { canonicalJson, type JsonValue } from "../json.js"

export type SearchEvidenceIdentity = Readonly<{
  bucket: string
  source: string
  document: string
  chunk: string
  text: string
  metadata: Readonly<Record<string, JsonValue>> | null
  title: string | null
  page: number | null
  section: string | null
}>

const digest = (value: JsonValue): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")

export const canonicalSearchSrn = (identity: SearchEvidenceIdentity): string =>
  `srn:schift:chunk:${digest({
    bucket: identity.bucket,
    source: identity.source,
    document: identity.document,
    chunk: identity.chunk,
  })}`

export const searchContentRevision = (identity: SearchEvidenceIdentity): string =>
  `sha256:${digest({
    bucket: identity.bucket,
    source: identity.source,
    document: identity.document,
    chunk: identity.chunk,
    text: identity.text,
    metadata: identity.metadata,
    title: identity.title,
    page: identity.page,
    section: identity.section,
  })}`
