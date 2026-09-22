import { randomUUID } from "node:crypto";

import {
  CandidateEnvelopeSchema,
  CapabilityBatchExecutionRequestSchema,
  CapabilityExecutionRequestSchema,
  KnowledgeScopeMountSchema,
  admitKnowledgeScopeCandidates,
  verifyKnowledgeScopeLock,
  type CandidateEnvelope,
  type KnowledgeScopeDefinition,
  type KnowledgeScopeMount,
  type QueryCapability,
  type ScopeRequirementReceipt,
} from "@schift-io/context-pack";

import {
  authorizationSubjectFromCandidate,
  type KnowledgeScopeAuthorization,
} from "./authorization.js";
import { productError } from "./errors.js";
import { canonicalJson } from "./json.js";
import { MAX_BINDINGS, MAX_CANDIDATES } from "./limits.js";
import type { PortableKnowledgeScope } from "./portable.js";
import { compileSchemaSubset } from "./schema-subset.js";
import {
  executeAndNormalize,
  prepareExecution,
  type ProviderExecutionPort,
} from "./application-execution.js";
import type { StoredKnowledgeScope } from "./state-contract.js";
import type { KnowledgeScopeStateStore } from "./state-store.js";
import { executeBatch } from "./application-batch.js";

type SourceBinding = KnowledgeScopeMount["sourceBindings"][number];
export type { ProviderExecutionContext, ProviderExecutionPort } from "./application-execution.js";
export {
  GLOBAL_MAX_RESULT_BYTES,
  GLOBAL_MAX_RESULT_ROWS,
  MAX_BINDINGS,
  MAX_CANDIDATES,
} from "./limits.js";

export type MountKnowledgeScopeInput = Readonly<{
  portable: PortableKnowledgeScope;
  scopeAuthority: unknown;
  sourceBindings: unknown;
}>;

export type KnowledgeScopeInspection = Readonly<{
  definition: KnowledgeScopeDefinition;
  lock: StoredKnowledgeScope["lock"];
  mount: KnowledgeScopeMount;
}>;

export type KnowledgeScopeRunResult =
  | Readonly<{ status: "ready"; candidates: readonly CandidateEnvelope[]; receipt: ScopeRequirementReceipt }>
  | Readonly<{ status: "insufficient_evidence"; candidates: readonly []; receipt: ScopeRequirementReceipt }>;

export type KnowledgeScopeApplicationOptions = Readonly<{
  store: KnowledgeScopeStateStore;
  authorization: KnowledgeScopeAuthorization;
  provider: ProviderExecutionPort;
  now?: () => Date;
}>;

const providerReference = (capability: QueryCapability): string => {
  switch (capability.provider.kind) {
    case "records_operation": return capability.provider.operationId;
    case "open_connector_action": return capability.provider.actionId;
    case "schift_search": return capability.provider.indexRef;
    case "local_documents": return capability.provider.indexRef;
    case "web_search": return capability.provider.provider;
  }
};

const coherentBinding = (binding: SourceBinding, capability: QueryCapability): boolean => {
  if (binding.providerRef !== providerReference(capability)) return false;
  if (capability.provider.kind !== "open_connector_action") return true;
  return binding.connectorRef === capability.provider.connectorRef;
};

export class KnowledgeScopeApplication {
  private readonly store: KnowledgeScopeStateStore;
  private readonly authorization: KnowledgeScopeAuthorization;
  private readonly provider: ProviderExecutionPort;
  private readonly now: () => Date;

  public constructor(options: KnowledgeScopeApplicationOptions) {
    this.store = options.store;
    this.authorization = options.authorization;
    this.provider = options.provider;
    this.now = options.now ?? (() => new Date());
  }

  public async mount(input: MountKnowledgeScopeInput): Promise<KnowledgeScopeMount> {
    const lock = input.portable.lock;
    if (lock === undefined) throw productError("lock_invalid");
    if (!await verifyKnowledgeScopeLock(input.portable.definition, input.portable.files, lock)) {
      throw productError("lock_invalid");
    }
    for (const capability of input.portable.definition.capabilities) {
      const inputSchema = input.portable.files[capability.inputSchemaRef];
      const resultSchema = input.portable.files[capability.resultSchemaRef];
      if (inputSchema === undefined || resultSchema === undefined) throw productError("lock_invalid");
      compileSchemaSubset(inputSchema);
      compileSchemaSubset(resultSchema);
    }
    const provisional = KnowledgeScopeMountSchema.safeParse({
      installationId: "ks-provisional",
      definitionDigest: lock.definitionDigest,
      scopeAuthority: input.scopeAuthority,
      sourceBindings: input.sourceBindings,
      state: "mounted",
      revision: 1,
    });
    if (!provisional.success) throw productError("definition_invalid");
    if (provisional.data.sourceBindings.length > MAX_BINDINGS) {
      throw productError("binding_limit_exceeded");
    }
    for (const binding of provisional.data.sourceBindings) {
      for (const operationId of binding.operationIds) {
        const capability = input.portable.definition.capabilities.find((item) => item.operationId === operationId);
        if (capability === undefined || !coherentBinding(binding, capability)) {
          throw productError("operation_not_bound");
        }
      }
    }
    const boundOperations = new Set(provisional.data.sourceBindings.flatMap((binding) => binding.operationIds));
    if (input.portable.definition.capabilities.length > 0 &&
      (boundOperations.size === 0 || provisional.data.sourceBindings.some((binding) =>
        binding.operationIds.length === 0))) throw productError("operation_not_bound");
    return this.store.transact((state) => {
      const replay = state.installations.find((entry) => entry.mount.state === "mounted" &&
        entry.mount.definitionDigest === provisional.data.definitionDigest &&
        entry.lock.lockDigest === lock.lockDigest &&
        canonicalJson(entry.mount.scopeAuthority) === canonicalJson(provisional.data.scopeAuthority) &&
        canonicalJson(entry.mount.sourceBindings) === canonicalJson(provisional.data.sourceBindings));
      if (replay !== undefined) return { state, value: replay.mount };
      const mount = KnowledgeScopeMountSchema.parse({
        ...provisional.data,
        installationId: `ks-${randomUUID()}`,
      });
      return {
        state: {
          ...state,
          revision: state.revision + 1,
          installations: [...state.installations, {
            definition: input.portable.definition,
            lock,
            files: input.portable.files,
            mount,
          }],
        },
        value: mount,
      };
    });
  }

  public async inspect(installationId: string): Promise<KnowledgeScopeInspection> {
    const stored = await this.findStored(installationId);
    return { definition: stored.definition, lock: stored.lock, mount: stored.mount };
  }

  public async unmount(installationId: string, expectedRevision: number): Promise<KnowledgeScopeMount> {
    return this.store.transact((state) => {
      const index = state.installations.findIndex((entry) => entry.mount.installationId === installationId);
      const stored = state.installations[index];
      if (stored === undefined) throw productError("installation_not_found");
      if (stored.mount.state === "unmounted" && stored.mount.revision === expectedRevision + 1) {
        return { state, value: stored.mount };
      }
      if (stored.mount.revision !== expectedRevision) throw productError("mount_conflict");
      const mount = KnowledgeScopeMountSchema.parse({
        ...stored.mount,
        state: "unmounted",
        sourceBindings: [],
        revision: stored.mount.revision + 1,
      });
      const installations = state.installations.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, mount } : entry);
      return { state: { ...state, revision: state.revision + 1, installations }, value: mount };
    });
  }

  public async run(rawRequest: unknown): Promise<KnowledgeScopeRunResult> {
    const parsedRequest = CapabilityExecutionRequestSchema.safeParse(rawRequest);
    if (!parsedRequest.success) throw productError("value_schema_mismatch");
    const request = parsedRequest.data;
    const stored = await this.findStored(request.installationId);
    const candidates = await executeAndNormalize(
      this.provider, this.authorization, stored, request, prepareExecution(stored, request),
    );
    const receipt = await this.admit(stored.mount.installationId, candidates);
    if (receipt.status !== "ready") return { status: "insufficient_evidence", candidates: [], receipt };
    if (receipt.candidateReceipts.length !== candidates.length) throw productError("state_corrupt");
    const accepted = candidates.filter((_candidate, index) =>
      receipt.candidateReceipts[index]?.status === "accepted");
    return { status: "ready", candidates: accepted, receipt };
  }

  public async runBatch(rawRequest: unknown): Promise<KnowledgeScopeRunResult> {
    const parsed = CapabilityBatchExecutionRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw productError("value_schema_mismatch");
    const stored = await this.findStored(parsed.data.installationId);
    const candidates = await executeBatch({ provider: this.provider, authorization: this.authorization }, stored, parsed.data);
    // Admission reloads the mount so revocation during provider execution takes effect.
    const receipt = await this.admit(parsed.data.installationId, candidates);
    if (receipt.status !== "ready") return { status: "insufficient_evidence", candidates: [], receipt };
    if (receipt.candidateReceipts.length !== candidates.length) throw productError("state_corrupt");
    if (receipt.candidateReceipts.some((item) => item.status === "denied")) throw productError("candidate_invalid");
    if (parsed.data.operations.some((operation) => !candidates.some((candidate) => candidate.operationId === operation.operationId))) {
      throw productError("batch_incomplete");
    }
    return { status: "ready", candidates, receipt };
  }

  public async admit(installationId: string, rawCandidates: readonly unknown[]): Promise<ScopeRequirementReceipt> {
    if (rawCandidates.length > MAX_CANDIDATES) throw productError("candidate_limit_exceeded");
    const verified = await this.findStored(installationId);
    const candidates = rawCandidates.map((value) => {
      const parsed = CandidateEnvelopeSchema.safeParse(value);
      if (!parsed.success) throw productError("candidate_invalid");
      return parsed.data;
    });
    const trusted = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      trustedAuthorizationDecision: await this.authorization.issue(authorizationSubjectFromCandidate(candidate)),
    })));
    const state = await this.store.read();
    const latest = state.installations.find((entry) => entry.mount.installationId === installationId);
    if (latest === undefined) throw productError("installation_not_found");
    if (latest.mount.definitionDigest !== verified.mount.definitionDigest ||
      canonicalJson(latest.definition) !== canonicalJson(verified.definition) ||
      canonicalJson(latest.lock) !== canonicalJson(verified.lock) ||
      canonicalJson(latest.files) !== canonicalJson(verified.files)) throw productError("state_corrupt");
    return admitKnowledgeScopeCandidates({
      definition: latest.definition, mount: latest.mount, candidates: trusted, evaluatedAt: this.now(),
    });
  }

  private async findStored(installationId: string): Promise<StoredKnowledgeScope> {
    const state = await this.store.read();
    const stored = state.installations.find((entry) => entry.mount.installationId === installationId);
    if (stored === undefined) throw productError("installation_not_found");
    if (stored.mount.definitionDigest !== stored.lock.definitionDigest ||
      !await verifyKnowledgeScopeLock(stored.definition, stored.files, stored.lock)) {
      throw productError("state_corrupt");
    }
    return stored;
  }
}
