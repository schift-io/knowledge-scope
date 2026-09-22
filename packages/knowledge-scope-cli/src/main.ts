#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  CapabilityExecutionRequestSchema,
  KnowledgeScopeDefinitionSchema,
  KnowledgeScopeLockSchema,
} from "@schift-io/context-pack";

import { KnowledgeScopeApplication, type ProviderExecutionPort } from "./application.js";
import { CapabilityBatchExecutionRequestSchema } from "@schift-io/context-pack";
import { createHttpProviderExecutionPort } from "./adapters/provider-port.js";
import type { HttpTransport } from "./adapters/types.js";
import { KnowledgeScopeAuthorization } from "./authorization.js";
import { createRemoteKnowledgeScopeApplication, KnowledgeScopeApiError, serveKnowledgeScopeApi } from "./api.js";
import type { KnowledgeScopeApplicationPort, MountApplicationRequest } from "./api.js";
import { runKnowledgeScopeCli, type CliDependencies, type PortableAuthoringPort } from "./cli.js";
import { productError } from "./errors.js";
import {
  DEFAULT_MAX_JSON_BYTES,
  decodeUtf8Strict,
  parseJsonText,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import { createPortableLock, loadPortableScope, verifyPortableLock } from "./portable.js";
import { KnowledgeScopeStateStore } from "./state-store.js";

const toJsonValue = (value: unknown): JsonValue => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new KnowledgeScopeApiError("internal_error", 500);
  return parseJsonText(serialized, "application output");
};
const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasCode = (value: unknown, code: string): boolean =>
  value !== null && typeof value === "object" && "code" in value && value.code === code;
const readNoFollowText = async (path: string): Promise<string> => {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) throw productError("path_invalid");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ELOOP")) throw productError("path_invalid");
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw productError("path_invalid");
    if (metadata.size > DEFAULT_MAX_JSON_BYTES) throw productError("json_limits_exceeded");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size <= DEFAULT_MAX_JSON_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, DEFAULT_MAX_JSON_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, size);
      if (bytesRead === 0) return decodeUtf8Strict(Buffer.concat(chunks, size));
      size += bytesRead;
      if (size > DEFAULT_MAX_JSON_BYTES) throw productError("json_limits_exceeded");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    throw productError("json_limits_exceeded");
  } finally { await handle.close(); }
};
const readJson = async (path: string): Promise<JsonValue> => parseJsonText(await readNoFollowText(path), path);

const authoring: PortableAuthoringPort = {
  validate: async (directory) => {
    const portable = await loadPortableScope(directory);
    const lockVerified = portable.lock === undefined ? false : await verifyPortableLock(directory);
    if (portable.lock !== undefined && !lockVerified) throw new KnowledgeScopeApiError("lock_invalid", 400);
    return { definitionDigest: portable.lock?.definitionDigest ?? null, lockVerified, status: "valid" };
  },
  lock: async (directory) => ({ lock: await createPortableLock(directory), status: "locked" }),
  mountPayload: async (directory, bindingsPath) => {
    const portable = await loadPortableScope(directory);
    if (portable.lock === undefined || !await verifyPortableLock(directory)) {
      throw new KnowledgeScopeApiError("lock_invalid", 400);
    }
    const bindings = await readJson(bindingsPath);
    if (!isJsonObject(bindings) || bindings["scopeAuthority"] === undefined || bindings["sourceBindings"] === undefined) {
      throw new KnowledgeScopeApiError("request_invalid", 400);
    }
    return {
      definition: toJsonValue(portable.definition),
      files: portable.files,
      lock: toJsonValue(portable.lock),
      scopeAuthority: bindings["scopeAuthority"],
      sourceBindings: bindings["sourceBindings"],
    };
  },
};

const applicationPort = (
  application: KnowledgeScopeApplication,
): KnowledgeScopeApplicationPort => ({
  mount: async (request: MountApplicationRequest) => toJsonValue(await application.mount({
    portable: {
      directory: "<wire>",
      definition: KnowledgeScopeDefinitionSchema.parse(request.definition),
      files: request.files,
      lock: KnowledgeScopeLockSchema.parse(request.lock),
    },
    scopeAuthority: request.scopeAuthority,
    sourceBindings: request.sourceBindings,
  })),
  inspect: async (installationId) => toJsonValue(await application.inspect(installationId)),
  run: async (request) => toJsonValue(await application.run(CapabilityExecutionRequestSchema.parse(request))),
  runBatch: async (request) => toJsonValue(await application.runBatch(CapabilityBatchExecutionRequestSchema.parse(request))),
  admit: async ({ installationId, candidates }) => toJsonValue(await application.admit(installationId, candidates)),
  unmount: async ({ installationId, expectedRevision }) =>
    toJsonValue(await application.unmount(installationId, expectedRevision)),
});

const scopes = (value: string | undefined): readonly string[] => value?.split(",")
  .map((item) => item.trim()).filter((item) => item.length > 0) ?? [];
const readOnlyActions = (raw: string | undefined): readonly Readonly<{
  connectorRef: string; connectorAlias: string; actionId: string;
}>[] => {
  if (raw === undefined) throw new KnowledgeScopeApiError("provider_unavailable", 503);
  const value = parseJsonText(raw, "SCHIFT_KS_OPEN_CONNECTOR_READ_ACTIONS");
  if (!Array.isArray(value) || value.length === 0) throw new KnowledgeScopeApiError("provider_unavailable", 503);
  return value.map((entry) => {
    if (!isJsonObject(entry) || Object.keys(entry).sort().join(",") !== "actionId,connectorAlias,connectorRef") {
      throw new KnowledgeScopeApiError("provider_unavailable", 503);
    }
    const actionId = entry["actionId"];
    const connectorAlias = entry["connectorAlias"];
    const connectorRef = entry["connectorRef"];
    if (typeof actionId !== "string" || actionId.length === 0 || typeof connectorAlias !== "string" ||
      connectorAlias.length === 0 || typeof connectorRef !== "string" || connectorRef.length === 0) {
      throw new KnowledgeScopeApiError("provider_unavailable", 503);
    }
    return { actionId, connectorAlias, connectorRef };
  });
};
const transport: HttpTransport = async (request) => globalThis.fetch(request.url, {
  method: request.method,
  headers: request.headers,
  ...(request.body === undefined ? {} : { body: request.body }),
  signal: request.signal,
  redirect: request.redirect,
});
const environmentProvider = (
  environment: Readonly<Record<string, string | undefined>>,
): ProviderExecutionPort => createHttpProviderExecutionPort({
  transport,
  runtimeResolver: {
    resolveOpenConnector: () => {
      const baseUrl = environment["SCHIFT_KS_OPEN_CONNECTOR_URL"];
      if (baseUrl === undefined) throw new KnowledgeScopeApiError("provider_unavailable", 503);
      return {
        baseUrl,
        grantedProviderScopes: scopes(environment["SCHIFT_KS_OPEN_CONNECTOR_SCOPES"]),
        readOnlyActions: readOnlyActions(environment["SCHIFT_KS_OPEN_CONNECTOR_READ_ACTIONS"]),
        timeoutMs: 30_000,
        ...(environment["SCHIFT_KS_OPEN_CONNECTOR_ALIAS"] === undefined ? {} : { connectorAlias: environment["SCHIFT_KS_OPEN_CONNECTOR_ALIAS"] }),
        ...(environment["SCHIFT_KS_OPEN_CONNECTOR_TOKEN"] === undefined ? {} : { bearerToken: environment["SCHIFT_KS_OPEN_CONNECTOR_TOKEN"] }),
      };
    },
    resolveSchiftSearch: () => {
      const baseUrl = environment["SCHIFT_KS_SEARCH_URL"];
      const bearerToken = environment["SCHIFT_KS_SEARCH_TOKEN"];
      const organizationId = environment["SCHIFT_KS_SEARCH_ORGANIZATION_ID"];
      if (baseUrl === undefined || bearerToken === undefined || bearerToken.length === 0 || organizationId === undefined) {
        throw new KnowledgeScopeApiError("provider_unavailable", 503);
      }
      return {
        baseUrl,
        bearerToken,
        organizationId,
        grantedProviderScopes: scopes(environment["SCHIFT_KS_SEARCH_SCOPES"]),
        timeoutMs: 30_000,
      };
    },
  },
});

export type KnowledgeScopeCliOptions = Readonly<{
  provider?: ProviderExecutionPort;
  home?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}>;

const trustedAuthority = (environment: Readonly<Record<string, string | undefined>>): JsonValue => ({
  organizationId: environment["SCHIFT_KS_ORGANIZATION_ID"] ?? "local-organization",
  tenant: environment["SCHIFT_KS_TENANT"] ?? "local-tenant",
});

export const createCliDependencies = (options: KnowledgeScopeCliOptions = {}): CliDependencies => {
  const environment = options.environment ?? process.env;
  const apiToken = environment["SCHIFT_KS_API_TOKEN"];
  const storageOptions = { environment, ...(options.home === undefined ? {} : { home: options.home }) };
  const store = new KnowledgeScopeStateStore(storageOptions);
  const authorization = new KnowledgeScopeAuthorization(storageOptions);
  const application = new KnowledgeScopeApplication({
    store,
    authorization,
    provider: options.provider ?? environmentProvider(environment),
  });
  const embedded = applicationPort(application);
  return {
    environment,
    authoring,
    embedded,
    remote: (apiUrl) => createRemoteKnowledgeScopeApplication(apiUrl, globalThis.fetch, apiToken),
    readJson,
    serve: async ({ host, port }) => serveKnowledgeScopeApi({
      application: embedded,
      mountAuthority: toJsonValue(trustedAuthority(environment)),
      host,
      port,
      ...(apiToken === undefined ? {} : { apiToken }),
    }),
  };
};

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<number> =>
  runKnowledgeScopeCli(argv, createCliDependencies(), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });

if (import.meta.main) process.exitCode = await main();
