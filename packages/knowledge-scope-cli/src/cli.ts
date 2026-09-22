import { mkdir, open } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  KnowledgeScopeApiError,
  type KnowledgeScopeApplicationPort,
  type MountApplicationRequest,
  type ServedKnowledgeScopeApi,
} from "./api.js";
import { MAX_CANDIDATES } from "./application.js";
import { CapabilityBatchExecutionRequestSchema } from "@schift-io/context-pack";
import { HttpProviderAdapterError } from "./adapters/provider-port.js";
import { LocalDocumentError } from "./local-documents/files.js";
import { KnowledgeScopeProductError } from "./errors.js";
import { canonicalJson, type JsonObject, type JsonValue } from "./json.js";
import { CliUsageError, parseCliOptions } from "./cli-options.js";
import { quickstart } from "./quickstart.js";
import { localQuickstart, type LocalDocumentImportPort } from "./local-quickstart.js";
import { queryProject } from "./local-query.js";
import { doctor } from "./doctor.js";
import { OnboardingError, type OnboardingEnvironment } from "./onboarding-config.js";

const COMMANDS = ["init", "validate", "lock", "mount", "inspect", "run", "run-batch", "admit", "unmount", "serve", "quickstart", "query", "doctor"] as const;
const HELP = {
  bin: "schift-ks", commands: COMMANDS,
  start: { example: "schift-ks quickstart ./my-project --source ./notes.md --query 'What is the refund policy?'", supported: [".md", ".txt", "directory"], accountRequired: false, behavior: "Imports a local snapshot; no upload or model calls." },
  followUp: "schift-ks query <installation-id> --query 'Your next question'",
  serve: { apiTokenEnvironment: "SCHIFT_KS_API_TOKEN", loopbackOnly: true, tokenRequired: true },
} as const;

export type PortableAuthoringPort = Readonly<{
  validate: (directory: string) => Promise<JsonValue>;
  lock: (directory: string) => Promise<JsonValue>;
  mountPayload: (directory: string, bindingsPath: string) => Promise<MountApplicationRequest>;
}>;
export type CliDependencies = Readonly<{
  environment?: OnboardingEnvironment;
  localDocuments?: LocalDocumentImportPort;
  authoring: PortableAuthoringPort;
  embedded: KnowledgeScopeApplicationPort;
  remote: (apiUrl: string) => KnowledgeScopeApplicationPort;
  serve: (options: Readonly<{ host: string; port: number }>) => Promise<Pick<ServedKnowledgeScopeApi, "host" | "port">>;
  readJson: (path: string) => Promise<JsonValue>;
}>;
export type CliStreams = Readonly<{ stdout: (line: string) => void; stderr: (line: string) => void }>;

const option = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliUsageError("argument_invalid");
  return value;
};
const requiredOption = (args: readonly string[], name: string): string => {
  const value = option(args, name);
  if (value === undefined) throw new CliUsageError("argument_missing");
  return value;
};
const integerOption = (args: readonly string[], name: string, fallback?: number): number => {
  const raw = option(args, name);
  if (raw === undefined && fallback !== undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new CliUsageError("argument_invalid");
  return parsed;
};
const objectValue = (value: JsonValue): JsonObject => {
  if (!isJsonObject(value)) throw new CliUsageError("input_invalid");
  return value;
};
const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const candidateBatch = (value: JsonValue): readonly JsonValue[] => {
  if (Array.isArray(value) && value.length > 0 && value.length <= MAX_CANDIDATES) return value;
  if (isJsonObject(value)) return [value];
  throw new CliUsageError("input_invalid");
};

const initialDefinition = (directory: string): JsonValue => {
  const inferred = basename(resolve(directory)).toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  const packId = inferred.length >= 2 ? inferred.slice(0, 128) : "example-scope";
  return {
    authority: {
      allowed: ["read", "draft"],
      forbidden: ["send", "approve", "mutate_source", "workflow"],
      precedence: ["primary", "operational", "approved", "observed", "derived"],
    },
    capabilities: [],
    contextPolicy: {
      mayConsider: [],
      mustConsider: [{ id: "trusted-context", minEvidence: 1, selector: { sourceClasses: ["document"] } }],
      mustNotUse: [{ id: "derived-context", selector: { authorities: ["derived"] } }],
    },
    evidence: {
      coverageAssertions: ["trusted-context"],
      freshness: { defaultMaxAgeSeconds: 86400 },
      requireCitation: true,
    },
    packId,
    responsibility: "trusted-context",
    scope: { descendants: ["namespace", "subject", "session"], root: "tenant" },
    version: "0.1.0",
  };
};
const initialize = async (directory: string): Promise<JsonValue> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(resolve(directory, "scope.json"), "wx", 0o600);
  try {
    await file.writeFile(`${canonicalJson(initialDefinition(directory))}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  return { directory, status: "initialized" };
};

const execute = async (argv: readonly string[], dependencies: CliDependencies): Promise<JsonValue> => {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return HELP;
  const command = argv[0];
  if (command === undefined) return HELP;
  const args = argv.slice(1);
  const positional = parseCliOptions(command, args);
  const apiUrl = option(args, "--api-url");
  const application = apiUrl === undefined ? dependencies.embedded : dependencies.remote(apiUrl);
  switch (command) {
    case "quickstart": {
      const source = option(args, "--source");
      if (source !== undefined) return localQuickstart({ directory: positional[0] ?? "", source, tenant: option(args, "--tenant") ?? "local-tenant", query: requiredOption(args, "--query") }, dependencies);
      return quickstart({ directory: positional[0] ?? "", index: requiredOption(args, "--index"), tenant: requiredOption(args, "--tenant"), query: requiredOption(args, "--query") }, dependencies, dependencies.environment ?? {});
    }
    case "query": return queryProject({ installationId: positional[0] ?? "", query: requiredOption(args, "--query") }, application);
    case "doctor": return doctor({ installationId: positional[0] ?? "", ...(args.includes("--probe") ? { query: requiredOption(args, "--query") } : {}) }, application, dependencies.environment ?? {});
    case "init": return initialize(positional[0] ?? (() => { throw new CliUsageError("argument_missing"); })());
    case "validate": return dependencies.authoring.validate(positional[0] ?? (() => { throw new CliUsageError("argument_missing"); })());
    case "lock": return dependencies.authoring.lock(positional[0] ?? (() => { throw new CliUsageError("argument_missing"); })());
    case "mount": {
      const directory = positional[0];
      if (directory === undefined) throw new CliUsageError("argument_missing");
      return application.mount(await dependencies.authoring.mountPayload(directory, requiredOption(args, "--bindings")));
    }
    case "inspect": return application.inspect(positional[0] ?? (() => { throw new CliUsageError("argument_missing"); })());
    case "run-batch": {
      const installationId = positional[0];
      if (installationId === undefined) throw new CliUsageError("argument_missing");
      const body = objectValue(await dependencies.readJson(requiredOption(args, "--input")));
      if (Object.keys(body).some((key) => !["effectiveScope", "operations", "expectedRevision"].includes(key))) throw new CliUsageError("input_invalid");
      const parsed = CapabilityBatchExecutionRequestSchema.safeParse({ ...body, installationId });
      if (!parsed.success) throw new CliUsageError("input_invalid");
      if (application.runBatch === undefined) throw new KnowledgeScopeApiError("batch_unsupported", 501);
      return application.runBatch(parsed.data);
    }
    case "run": {
      const installationId = positional[0];
      const operationId = positional[1];
      if (installationId === undefined || operationId === undefined) throw new CliUsageError("argument_missing");
      const body = objectValue(await dependencies.readJson(requiredOption(args, "--input")));
      const effectiveScope = body["effectiveScope"];
      const input = body["input"];
      if (effectiveScope === undefined || input === undefined) throw new CliUsageError("input_invalid");
      return application.run({
        installationId, operationId, effectiveScope, input,
        ...(body["filters"] === undefined ? {} : { filters: body["filters"] }),
        ...(typeof body["expectedRevision"] === "number" ? { expectedRevision: body["expectedRevision"] } : {}),
      });
    }
    case "admit": {
      const installationId = positional[0];
      if (installationId === undefined) throw new CliUsageError("argument_missing");
      const candidates = candidateBatch(await dependencies.readJson(requiredOption(args, "--candidate")));
      return application.admit({ installationId, candidates });
    }
    case "unmount": {
      const installationId = positional[0];
      if (installationId === undefined) throw new CliUsageError("argument_missing");
      return application.unmount({ installationId, expectedRevision: integerOption(args, "--expected-revision") });
    }
    case "serve": {
      if (args.includes("--allow-non-loopback")) throw new CliUsageError("argument_invalid");
      return dependencies.serve({ host: option(args, "--host") ?? "127.0.0.1", port: integerOption(args, "--port", 8787) });
    }
    default: throw new CliUsageError("command_unknown");
  }
};

const errorCode = (error: unknown): string => {
  if (error instanceof LocalDocumentError || error instanceof OnboardingError || error instanceof CliUsageError || error instanceof KnowledgeScopeApiError ||
    error instanceof KnowledgeScopeProductError || error instanceof HttpProviderAdapterError) {
    return error.code;
  }
  return "internal_error";
};

export const runKnowledgeScopeCli = async (
  argv: readonly string[],
  dependencies: CliDependencies,
  streams: CliStreams,
): Promise<number> => {
  try {
    streams.stdout(JSON.stringify(await execute(argv, dependencies)));
    return 0;
  } catch (error) { // no-excuse-ok: catch -- CLI boundary emits only stable redacted errors.
    streams.stderr(JSON.stringify({ code: errorCode(error), status: "error", ...(error instanceof OnboardingError ? error.details : {}) }));
    return 1;
  }
};
