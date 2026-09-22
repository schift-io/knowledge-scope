import { z } from "zod";

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const PackIdSchema = z.string().regex(IDENTIFIER_PATTERN).brand<"PackId">();
export const SourceIdSchema = z.string().regex(IDENTIFIER_PATTERN).brand<"SourceId">();
export const RevisionIdSchema = z.string().regex(IDENTIFIER_PATTERN).brand<"RevisionId">();
export const RuntimeIdSchema = z.string().regex(IDENTIFIER_PATTERN).brand<"RuntimeId">();
export const InstallationIdSchema = z
  .string()
  .regex(IDENTIFIER_PATTERN)
  .brand<"InstallationId">();
export const SemanticVersionSchema = z
  .string()
  .regex(SEMVER_PATTERN)
  .brand<"SemanticVersion">();
export const Sha256DigestSchema = z
  .string()
  .regex(SHA256_PATTERN)
  .brand<"Sha256Digest">();

export type PackId = z.infer<typeof PackIdSchema>;
export type SourceId = z.infer<typeof SourceIdSchema>;
export type RevisionId = z.infer<typeof RevisionIdSchema>;
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;
export type InstallationId = z.infer<typeof InstallationIdSchema>;
export type SemanticVersion = z.infer<typeof SemanticVersionSchema>;
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;
