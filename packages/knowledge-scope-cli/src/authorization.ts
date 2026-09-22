import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AuthorizationDecisionSchema,
  CandidateEnvelopeSchema,
  type AuthorizationDecision,
} from "@schift-io/context-pack";

import { productError } from "./errors.js";
import { canonicalJson } from "./json.js";

export const AuthorizationSubjectSchema = CandidateEnvelopeSchema.unwrap().pick({
  srn: true,
  sourceId: true,
  sourceClass: true,
  providerRef: true,
  installationId: true,
  definitionDigest: true,
  mountRevision: true,
  operationId: true,
  scopeAuthority: true,
  effectiveScope: true,
  revision: true,
  permission: true,
  permissionMode: true,
  providerScopes: true,
  providerEvidence: true,
  freshness: true,
  payload: true,
  citation: true,
}).strict().readonly();

export type AuthorizationSubject = typeof AuthorizationSubjectSchema._output;

export const authorizationSubjectFromCandidate = (
  candidate: typeof CandidateEnvelopeSchema._output,
): AuthorizationSubject => AuthorizationSubjectSchema.parse({
  srn: candidate.srn,
  sourceId: candidate.sourceId,
  sourceClass: candidate.sourceClass,
  providerRef: candidate.providerRef,
  installationId: candidate.installationId,
  definitionDigest: candidate.definitionDigest,
  mountRevision: candidate.mountRevision,
  operationId: candidate.operationId,
  scopeAuthority: candidate.scopeAuthority,
  effectiveScope: candidate.effectiveScope,
  revision: candidate.revision,
  permission: candidate.permission,
  permissionMode: candidate.permissionMode,
  providerScopes: candidate.providerScopes,
  providerEvidence: candidate.providerEvidence,
  ...(candidate.freshness === undefined ? {} : { freshness: candidate.freshness }),
  payload: candidate.payload,
  ...(candidate.citation === undefined ? {} : { citation: candidate.citation }),
});

export type KnowledgeScopeAuthorizationOptions = Readonly<{
  home?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  faults?: AuthorizationFaults;
}>;

export interface AuthorizationFaults {
  beforeInstall(): Promise<void>;
}

const hasCode = (value: unknown, code: string): boolean =>
  value !== null && typeof value === "object" && "code" in value && value.code === code;

const assertOwnerOnly = async (path: string, directory: boolean): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
    (directory ? !metadata.isDirectory() : !metadata.isFile())) {
    throw productError("state_permissions_invalid");
  }
};

const readOwnerOnlyKey = async (path: string): Promise<Buffer> => {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw productError("state_permissions_invalid");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ELOOP")) throw productError("state_permissions_invalid");
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw productError("state_permissions_invalid");
    }
    if (metadata.size !== 32) throw productError("authorization_invalid");
    return handle.readFile();
  } finally {
    await handle.close();
  }
};

export class KnowledgeScopeAuthorization {
  private readonly home: string;
  private readonly keyPath: string;
  private readonly faults: AuthorizationFaults | undefined;

  public constructor(options: KnowledgeScopeAuthorizationOptions = {}) {
    const environment = options.environment ?? process.env;
    this.home = options.home ?? environment["SCHIFT_KS_HOME"] ?? join(homedir(), ".schift", "knowledge-scope");
    this.keyPath = join(this.home, "authorization.key");
    this.faults = options.faults;
  }

  public async issue(subject: AuthorizationSubject): Promise<AuthorizationDecision> {
    const digest = await this.digest(subject);
    return AuthorizationDecisionSchema.parse({
      decisionId: `auth-${digest.slice("sha256:".length, "sha256:".length + 24)}`,
      decisionDigest: digest,
      status: "allowed",
    });
  }

  public async verify(subject: AuthorizationSubject, decision: AuthorizationDecision): Promise<boolean> {
    const expected = await this.issue(subject);
    const left = Buffer.from(canonicalJson(expected));
    const right = Buffer.from(canonicalJson(decision));
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
  }

  private async digest(subject: AuthorizationSubject): Promise<string> {
    const key = await this.readOrCreateKey();
    return `sha256:${createHmac("sha256", key).update(canonicalJson(subject)).digest("hex")}`;
  }

  private async readOrCreateKey(): Promise<Buffer> {
    const created = await mkdir(this.home, { recursive: true, mode: 0o700 });
    if (created === undefined) await assertOwnerOnly(this.home, true);
    else await chmod(this.home, 0o700);
    try {
      return await readOwnerOnlyKey(this.keyPath);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    await this.installKeyIfAbsent();
    const key = await readOwnerOnlyKey(this.keyPath);
    return key;
  }

  private async installKeyIfAbsent(): Promise<void> {
    const temporaryPath = join(this.home, `.authorization-key-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
      if (this.faults !== undefined) await this.faults.beforeInstall();
      try {
        await link(temporaryPath, this.keyPath);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        return;
      }
      const directory = await open(this.home, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle.close();
      await rm(temporaryPath, { force: true });
    }
  }
}
