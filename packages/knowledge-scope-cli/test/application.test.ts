import { afterEach, describe, expect, it } from "bun:test";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CapabilityExecutionRequestSchema,
  KnowledgeScopeMountSchema,
  ProviderResultSchema,
} from "@schift-io/context-pack";

import {
  KnowledgeScopeApplication,
  GLOBAL_MAX_RESULT_BYTES,
  MAX_BINDINGS,
  MAX_CANDIDATES,
  type ProviderExecutionContext,
  type ProviderExecutionPort,
} from "../src/application.js";
import { KnowledgeScopeAuthorization } from "../src/authorization.js";
import { loadPortableScope, createPortableLock } from "../src/portable.js";
import { KnowledgeScopeStateStore } from "../src/state-store.js";
import { MAX_STATE_BYTES, MAX_STATE_NODES } from "../src/state-store.js";

const paths: string[] = [];

const definition = {
  packId: "support-pack",
  version: "1.0.0",
  responsibility: "support.answers",
  scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
  capabilities: [{
    operationId: "search.docs",
    provider: { kind: "schift_search", indexRef: "support-index" },
    inputSchemaRef: "schemas/input.json",
    resultSchemaRef: "schemas/result.json",
    allowedFilters: ["locale"],
    limits: { maxRows: 2, maxResultBytes: 4096 },
  }],
  contextPolicy: {
    mustConsider: [{ id: "support.docs", selector: { sourceIds: ["support-docs"] }, minEvidence: 1 }],
    mustNotUse: [{ id: "private.notes", selector: { sourceIds: ["private-notes"] } }],
  },
  authority: {
    precedence: ["primary"],
    allowed: ["read"],
    forbidden: ["send", "approve", "mutate_source", "workflow"],
  },
  evidence: {
    requireCitation: true,
    freshness: { defaultMaxAgeSeconds: 3600 },
    coverageAssertions: ["support.docs"],
  },
};

const createPortable = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "schift-ks-app-portable-"));
  paths.push(directory);
  await mkdir(join(directory, "schemas"));
  await writeFile(join(directory, "scope.json"), JSON.stringify(definition));
  await writeFile(join(directory, "schemas/input.json"), JSON.stringify({
    type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
  }));
  await writeFile(join(directory, "schemas/result.json"), JSON.stringify({
    type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
  }));
  await createPortableLock(directory);
  return directory;
};

class FakeSearchPort implements ProviderExecutionPort {
  public calls = 0;
  public validatorsObserved = false;

  public async execute(context: ProviderExecutionContext): Promise<readonly ReturnType<typeof ProviderResultSchema.parse>[]> {
    this.calls += 1;
    this.validatorsObserved = context.validateInput({ query: "safe" }).valid &&
      context.validateResult({ text: "safe" }).valid;
    return [ProviderResultSchema.parse({
      srn: "srn:docs/server-issued",
      resultId: "result-1",
      revision: "revision-1",
      freshness: "2026-09-22T06:00:00.000Z",
      payload: { text: "Use the documented reset flow" },
      citation: { uri: "https://example.com/support/reset" },
      providerScopes: [],
      providerEvidence: { kind: "schift_search", indexRef: "support-index" },
    })];
  }
}

class UncitedSearchPort implements ProviderExecutionPort {
  public async execute(): Promise<readonly ReturnType<typeof ProviderResultSchema.parse>[]> {
    return [ProviderResultSchema.parse({
      resultId: "result-uncited", revision: "revision-1",
      freshness: "2026-09-22T06:00:00.000Z", payload: { text: "Untrusted" },
      providerScopes: [],
      providerEvidence: { kind: "schift_search", indexRef: "support-index" },
    })];
  }
}

class DuplicateSrnSearchPort implements ProviderExecutionPort {
  public async execute(): Promise<readonly ReturnType<typeof ProviderResultSchema.parse>[]> {
    const common = {
      srn: "srn:docs/duplicate",
      revision: "revision-1",
      freshness: "2026-09-22T06:00:00.000Z",
      providerScopes: [],
      providerEvidence: { kind: "schift_search", indexRef: "support-index" },
    } as const;
    return [
      ProviderResultSchema.parse({
        ...common, resultId: "result-accepted", payload: { text: "accepted evidence" },
        citation: { uri: "https://example.com/support/accepted" },
      }),
      ProviderResultSchema.parse({
        ...common, resultId: "result-denied", payload: { text: "must not leak" },
      }),
    ];
  }
}

class ExcessiveRowsPort implements ProviderExecutionPort {
  public calls = 0;

  public async execute(): Promise<readonly ReturnType<typeof ProviderResultSchema.parse>[]> {
    this.calls += 1;
    return Array.from({ length: MAX_CANDIDATES + 1 }, (_, index) => ProviderResultSchema.parse({
      resultId: `result-${index}`,
      revision: "revision-1",
      freshness: "2026-09-22T06:00:00.000Z",
      payload: { text: `evidence-${index}` },
      citation: { uri: `https://example.com/support/${index}` },
      providerScopes: [],
      providerEvidence: { kind: "schift_search", indexRef: "support-index" },
    }));
  }
}

class ExcessiveBytesPort implements ProviderExecutionPort {
  public calls = 0;

  public async execute(): Promise<readonly ReturnType<typeof ProviderResultSchema.parse>[]> {
    this.calls += 1;
    const chunk = "x".repeat(Math.ceil(GLOBAL_MAX_RESULT_BYTES / (MAX_CANDIDATES * 2)) + 1_024);
    return Array.from({ length: MAX_CANDIDATES }, (_, index) => ProviderResultSchema.parse({
      resultId: `result-${index}`,
      revision: "revision-1",
      freshness: "2026-09-22T06:00:00.000Z",
      payload: { text: chunk, more: chunk },
      citation: { uri: `https://example.com/support/${index}` },
      providerScopes: [],
      providerEvidence: { kind: "schift_search", indexRef: "support-index" },
    }));
  }
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("KnowledgeScopeApplication", () => {
  it("persists schemas independently of the source directory and admits a run after restart", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const portable = await loadPortableScope(directory);
    const provider = new FakeSearchPort();
    const first = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider,
      now: () => new Date("2026-09-22T06:00:01.000Z"),
    });
    const mount = await first.mount({
      portable,
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });
    await rm(directory, { recursive: true, force: true });

    // When
    const restarted = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider,
      now: () => new Date("2026-09-22T06:00:01.000Z"),
    });
    const result = await restarted.run(CapabilityExecutionRequestSchema.parse({
      installationId: mount.installationId,
      operationId: "search.docs",
      effectiveScope: { tenant: "acme" },
      input: { query: "reset" },
      filters: { locale: "ko" },
      expectedRevision: 1,
    }));

    // Then
    expect(result.receipt.status).toBe("ready");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.srn).toBe("srn:docs/server-issued");
    expect(result.candidates[0]?.permissionMode).toBe("live");
    expect(result.candidates[0]?.permission).toBe("mount:1:support-docs:live");
    expect(provider.calls).toBe(1);
    expect(provider.validatorsObserved).toBe(true);
  });

  it("keeps an unmount tombstone and rejects stale revisions", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    const tombstone = await application.unmount(mount.installationId, 1);

    // Then
    expect(tombstone.state).toBe("unmounted");
    expect(tombstone.revision).toBe(2);
    await expect(application.unmount(mount.installationId, 1)).resolves.toEqual(tombstone);
    await expect(application.unmount(mount.installationId, 4)).rejects.toThrow("mount_conflict");
  });

  it("never returns candidates when aggregate evidence is insufficient", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new UncitedSearchPort(),
      now: () => new Date("2026-09-22T06:00:01.000Z"),
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    const result = await application.run(CapabilityExecutionRequestSchema.parse({
      installationId: mount.installationId, operationId: "search.docs",
      effectiveScope: { tenant: "acme" }, input: { query: "reset" },
    }));

    // Then
    expect(result.status).toBe("insufficient_evidence");
    expect(result.candidates).toEqual([]);
  });

  it("rejects malformed requests and prohibited bindings before provider dispatch", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const provider = new FakeSearchPort();
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider,
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [
        { sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
          authority: "primary", permissionMode: "live", operationIds: ["search.docs"] },
        { sourceId: "private-notes", sourceClass: "document", providerRef: "support-index",
          authority: "primary", permissionMode: "live", operationIds: ["search.docs"] },
      ],
    });

    // When
    const malformed = application.run({
      installationId: mount.installationId, operationId: "search.docs",
      effectiveScope: { tenant: "acme" }, input: { query: "reset" }, injected: true,
    });

    // Then
    await expect(malformed).rejects.toThrow("value_schema_mismatch");
    expect(provider.calls).toBe(0);
    await application.run({
      installationId: mount.installationId, operationId: "search.docs",
      effectiveScope: { tenant: "acme" }, input: { query: "reset" },
    });
    expect(provider.calls).toBe(1);
  });

  it("ignores caller authorization claims and verifies the local HMAC", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
      now: () => new Date("2026-09-22T06:00:01.000Z"),
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });
    const run = await application.run({
      installationId: mount.installationId, operationId: "search.docs",
      effectiveScope: { tenant: "acme" }, input: { query: "reset" },
    });
    const candidate = run.candidates[0];
    if (candidate === undefined) throw new Error("expected ready candidate");

    // When
    const receipt = await application.admit(mount.installationId, [{
      ...candidate,
      authorizationDecision: {
        ...candidate.authorizationDecision,
        decisionDigest: `sha256:${"b".repeat(64)}`,
      },
    }]);

    // Then
    expect(receipt.status).toBe("insufficient_evidence");
    expect(receipt.candidateReceipts[0]).toMatchObject({
      status: "denied",
      reasonCode: "authorization_decision_untrusted",
    });
  });

  it("rejects mutations to every signed evidence field", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
      now: () => new Date("2026-09-22T06:00:01.000Z"),
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });
    const run = await application.run({
      installationId: mount.installationId, operationId: "search.docs",
      effectiveScope: { tenant: "acme" }, input: { query: "reset" },
    });
    const candidate = run.candidates[0];
    if (candidate === undefined) throw new Error("expected ready candidate");
    const mutations = [
      { ...candidate, srn: "srn:docs/mutated" },
      { ...candidate, payload: { text: "mutated" } },
      { ...candidate, revision: "revision-2" },
      { ...candidate, permission: "mount:1:support-docs:static" },
      { ...candidate, freshness: "2026-09-22T05:59:59.000Z" },
      { ...candidate, citation: { uri: "https://example.com/tampered" } },
      { ...candidate, providerScopes: ["search:admin"] },
      { ...candidate, providerEvidence: { kind: "schift_search", indexRef: "other-index" } },
    ];

    // When
    const receipts = await Promise.all(mutations.map((mutated) =>
      application.admit(mount.installationId, [mutated])));

    // Then
    expect(receipts.map((receipt) => receipt.candidateReceipts[0])).toEqual(
      mutations.map(() => expect.objectContaining({
        status: "denied",
        reasonCode: "authorization_decision_untrusted",
      })),
    );
  });

  it("pairs admission receipts by index when duplicate SRNs have mixed decisions", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new DuplicateSrnSearchPort(),
      now: () => new Date("2026-09-22T06:00:01.000Z"),
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    const result = await application.run({
      installationId: mount.installationId, operationId: "search.docs",
      effectiveScope: { tenant: "acme" }, input: { query: "reset" },
    });

    // Then
    expect(result.status).toBe("ready");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.payload).toEqual({ text: "accepted evidence" });
    expect(result.receipt.candidateReceipts.map((item) => item.status)).toEqual(["accepted", "denied"]);
  });

  it("rejects a mount when a declared capability has no coherent binding", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
    });

    // When
    const mounting = application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: [],
      }],
    });

    // Then
    await expect(mounting).rejects.toThrow("operation_not_bound");
  });

  it("allows an optional declared capability to remain unbound", async () => {
    // Given
    const directory = await createPortable();
    await writeFile(join(directory, "scope.json"), JSON.stringify({
      ...definition,
      capabilities: [
        ...definition.capabilities,
        {
          operationId: "search.optional",
          provider: { kind: "schift_search", indexRef: "optional-index" },
          inputSchemaRef: "schemas/input.json",
          resultSchemaRef: "schemas/result.json",
        },
      ],
    }));
    await createPortableLock(directory);
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
    });

    // When
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // Then
    expect(mount.state).toBe("mounted");
    await expect(application.run({
      installationId: mount.installationId,
      operationId: "search.optional",
      effectiveScope: { tenant: "acme" },
      input: { query: "optional" },
    })).rejects.toThrow("operation_not_bound");
  });

  it("rejects oversized state without replacing the readable mount", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const store = new KnowledgeScopeStateStore({ home });
    const application = new KnowledgeScopeApplication({
      store,
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    const oversized = store.transact((state) => ({
      state: {
        ...state,
        revision: state.revision + 1,
        installations: state.installations.map((entry) => ({
          ...entry,
          files: { ...entry.files, "oversized.txt": "x".repeat(MAX_STATE_BYTES) },
        })),
      },
      value: undefined,
    }));

    // Then
    await expect(oversized).rejects.toThrow("state_capacity_exceeded");
    await expect(application.inspect(mount.installationId)).resolves.toMatchObject({
      mount: { installationId: mount.installationId, state: "mounted" },
    });
  });

  it("persists a depth-sixteen portable schema across restart", async () => {
    // Given
    const directory = await createPortable();
    let deepSchema: Readonly<Record<string, unknown>> = { type: "string" };
    for (let depth = 0; depth < 15; depth += 1) deepSchema = { type: "array", items: deepSchema };
    await writeFile(join(directory, "schemas/result.json"), JSON.stringify(deepSchema));
    await createPortableLock(directory);
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const store = new KnowledgeScopeStateStore({ home });
    const application = new KnowledgeScopeApplication({
      store,
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    const restarted = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
    });

    // Then
    await expect(restarted.inspect(mount.installationId)).resolves.toMatchObject({
      mount: { installationId: mount.installationId, state: "mounted" },
    });
  });

  it("rejects a many-mount state beyond the node ceiling without replacing prior state", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const store = new KnowledgeScopeStateStore({ home });
    const application = new KnowledgeScopeApplication({
      store,
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    const excessive = store.transact((state) => {
      const base = state.installations[0];
      if (base === undefined) throw new Error("expected mounted state");
      return {
        state: {
          ...state,
          revision: state.revision + 1,
          installations: Array.from({ length: Math.ceil(MAX_STATE_NODES / 40) }, (_, index) => ({
            ...base,
            mount: KnowledgeScopeMountSchema.parse({
              ...base.mount,
              installationId: `ks-node-${index}`,
            }),
          })),
        },
        value: undefined,
      };
    });

    // Then
    await expect(excessive).rejects.toThrow("state_capacity_exceeded");
    await expect(application.inspect(mount.installationId)).resolves.toMatchObject({
      mount: { installationId: mount.installationId, state: "mounted" },
    });
  });

  it("prevents a delayed first initializer from erasing a committed mount", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    let markReady = (): void => {};
    let release = (): void => {};
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = new KnowledgeScopeStateStore({
      home,
      faults: { beforeRename: async () => { markReady(); await gate; } },
    });
    const delayedInitialization = delayed.initialize();
    await ready;
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider: new FakeSearchPort(),
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    release();
    await delayedInitialization;

    // Then
    await expect(application.inspect(mount.installationId)).resolves.toMatchObject({
      mount: { installationId: mount.installationId, state: "mounted" },
    });
  });

  it("rejects excessive bindings before any provider or authorization work", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const provider = new FakeSearchPort();
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider,
    });

    // When
    const mounting = application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: Array.from({ length: MAX_BINDINGS + 1 }, (_, index) => ({
        sourceId: `support-${index}`, sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      })),
    });

    // Then
    await expect(mounting).rejects.toThrow("binding_limit_exceeded");
    expect(provider.calls).toBe(0);
    await expect(access(join(home, "authorization.key"))).rejects.toBeDefined();
  });

  it("rejects excessive external candidates before parsing or HMAC work", async () => {
    // Given
    const directory = await createPortable();
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const provider = new FakeSearchPort();
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider,
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    const admitting = application.admit(
      mount.installationId,
      Array.from({ length: MAX_CANDIDATES + 1 }, () => ({})),
    );

    // Then
    await expect(admitting).rejects.toThrow("candidate_limit_exceeded");
    expect(provider.calls).toBe(0);
    await expect(access(join(home, "authorization.key"))).rejects.toBeDefined();
  });

  it("rejects merged provider rows before creating any authorization decision", async () => {
    // Given
    const directory = await createPortable();
    await writeFile(join(directory, "scope.json"), JSON.stringify({
      ...definition,
      capabilities: definition.capabilities.map((capability) => ({
        operationId: capability.operationId,
        provider: capability.provider,
        inputSchemaRef: capability.inputSchemaRef,
        resultSchemaRef: capability.resultSchemaRef,
        allowedFilters: capability.allowedFilters,
      })),
    }));
    await createPortableLock(directory);
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const provider = new ExcessiveRowsPort();
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider,
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    const running = application.run({
      installationId: mount.installationId, operationId: "search.docs",
      effectiveScope: { tenant: "acme" }, input: { query: "reset" },
    });

    // Then
    await expect(running).rejects.toThrow("result_limits_exceeded");
    expect(provider.calls).toBe(1);
    await expect(access(join(home, "authorization.key"))).rejects.toBeDefined();
  });

  it("rejects aggregate provider bytes before creating any authorization decision", async () => {
    // Given
    const directory = await createPortable();
    await writeFile(join(directory, "scope.json"), JSON.stringify({
      ...definition,
      capabilities: definition.capabilities.map((capability) => ({
        operationId: capability.operationId,
        provider: capability.provider,
        inputSchemaRef: capability.inputSchemaRef,
        resultSchemaRef: capability.resultSchemaRef,
        allowedFilters: capability.allowedFilters,
      })),
    }));
    await writeFile(join(directory, "schemas/result.json"), JSON.stringify({
      type: "object",
      properties: { text: { type: "string" }, more: { type: "string" } },
      required: ["text", "more"],
      additionalProperties: false,
    }));
    await createPortableLock(directory);
    const home = await mkdtemp(join(tmpdir(), "schift-ks-app-home-"));
    paths.push(home);
    await chmod(home, 0o700);
    const provider = new ExcessiveBytesPort();
    const application = new KnowledgeScopeApplication({
      store: new KnowledgeScopeStateStore({ home }),
      authorization: new KnowledgeScopeAuthorization({ home }),
      provider,
    });
    const mount = await application.mount({
      portable: await loadPortableScope(directory),
      scopeAuthority: { organizationId: "acme-org", tenant: "acme" },
      sourceBindings: [{
        sourceId: "support-docs", sourceClass: "document", providerRef: "support-index",
        authority: "primary", permissionMode: "live", operationIds: ["search.docs"],
      }],
    });

    // When
    const running = application.run({
      installationId: mount.installationId, operationId: "search.docs",
      effectiveScope: { tenant: "acme" }, input: { query: "reset" },
    });

    // Then
    await expect(running).rejects.toThrow("result_limits_exceeded");
    expect(provider.calls).toBe(1);
    await expect(access(join(home, "authorization.key"))).rejects.toBeDefined();
  });
});
