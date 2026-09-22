import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AuthorizationSubjectSchema,
  KnowledgeScopeAuthorization,
} from "../src/authorization.js";

const homes: string[] = [];
const subject = {
  srn: "srn:docs/support/1",
  sourceId: "support-docs",
  sourceClass: "document",
  providerRef: "support-index",
  installationId: "installation-acme",
  definitionDigest: `sha256:${"a".repeat(64)}`,
  mountRevision: 1,
  operationId: "search.docs",
  scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
  effectiveScope: { tenant: "acme", namespace: "support" },
  revision: "revision-1",
  permission: "mount:1:support-docs:live",
  permissionMode: "live",
  providerScopes: [],
  providerEvidence: { kind: "schift_search", indexRef: "support-index" },
  freshness: "2026-09-22T06:00:00.000Z",
  payload: { text: "evidence" },
  citation: { uri: "https://example.com/support/1" },
} as const;

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("KnowledgeScopeAuthorization", () => {
  it("reuses an owner-only key across process instances", async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "schift-ks-auth-"));
    homes.push(home);
    await chmod(home, 0o700);
    const first = new KnowledgeScopeAuthorization({ home });

    // When
    const decision = await first.issue(AuthorizationSubjectSchema.parse(subject));
    const second = new KnowledgeScopeAuthorization({ home });

    // Then
    expect(await second.verify(AuthorizationSubjectSchema.parse(subject), decision)).toBe(true);
    expect((await stat(join(home, "authorization.key"))).mode & 0o777).toBe(0o600);
  });

  it("invalidates an outstanding decision after manual key replacement", async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "schift-ks-auth-"));
    homes.push(home);
    await chmod(home, 0o700);
    const authorization = new KnowledgeScopeAuthorization({ home });
    const parsedSubject = AuthorizationSubjectSchema.parse(subject);
    const decision = await authorization.issue(parsedSubject);

    // When
    await writeFile(join(home, "authorization.key"), Buffer.alloc(32, 7), { mode: 0o600 });

    // Then
    expect(await new KnowledgeScopeAuthorization({ home }).verify(parsedSubject, decision)).toBe(false);
  });

  it("rejects a symbolic-link key without reading its target", async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "schift-ks-auth-"));
    const externalHome = await mkdtemp(join(tmpdir(), "schift-ks-auth-external-"));
    homes.push(home, externalHome);
    await chmod(home, 0o700);
    const externalKey = join(externalHome, "key");
    await writeFile(externalKey, Buffer.alloc(32, 9), { mode: 0o600 });
    await symlink(externalKey, join(home, "authorization.key"));

    // When / Then
    await expect(new KnowledgeScopeAuthorization({ home }).issue(AuthorizationSubjectSchema.parse(subject)))
      .rejects.toThrow("state_permissions_invalid");
  });

  it("keeps the winning complete key when first-creation installers race", async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "schift-ks-auth-"));
    homes.push(home);
    await chmod(home, 0o700);
    let markReady = (): void => {};
    let release = (): void => {};
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = new KnowledgeScopeAuthorization({
      home,
      faults: { beforeInstall: async () => { markReady(); await gate; } },
    });
    const delayedDecision = delayed.issue(AuthorizationSubjectSchema.parse(subject));
    await ready;

    // When
    const winnerDecision = await new KnowledgeScopeAuthorization({ home })
      .issue(AuthorizationSubjectSchema.parse(subject));
    release();
    const completedDecision = await delayedDecision;

    // Then
    expect(completedDecision).toEqual(winnerDecision);
    expect((await stat(join(home, "authorization.key"))).size).toBe(32);
  });
});
