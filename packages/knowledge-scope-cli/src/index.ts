export {
  createKnowledgeScopeApi,
  createRemoteKnowledgeScopeApplication,
  serveKnowledgeScopeApi,
  KnowledgeScopeApiError,
} from "./api.js";
export type {
  KnowledgeScopeApplicationPort,
  MountApplicationRequest,
  RunApplicationRequest,
  RunBatchApplicationRequest,
  AdmitApplicationRequest,
  UnmountApplicationRequest,
  ServedKnowledgeScopeApi,
} from "./api.js";
export { runKnowledgeScopeCli } from "./cli.js";
export type { CliDependencies, CliStreams, PortableAuthoringPort } from "./cli.js";
export { createCliDependencies, main } from "./main.js";

export {
  GLOBAL_MAX_RESULT_BYTES,
  GLOBAL_MAX_RESULT_ROWS,
  KnowledgeScopeApplication,
  MAX_BINDINGS,
  MAX_CANDIDATES,
} from "./application.js";
export type {
  KnowledgeScopeApplicationOptions,
  KnowledgeScopeInspection,
  KnowledgeScopeRunResult,
  MountKnowledgeScopeInput,
  ProviderExecutionContext,
  ProviderExecutionPort,
} from "./application.js";

export {
  createPortableLock,
  loadPortableScope,
  verifyPortableLock,
} from "./portable.js";
export type { PortableKnowledgeScope } from "./portable.js";

export {
  KNOWLEDGE_SCOPE_ERROR_CODES,
  KnowledgeScopeProductError,
} from "./errors.js";
export type { KnowledgeScopeErrorCode } from "./errors.js";

export {
  createHttpProviderExecutionPort,
  HttpProviderAdapterError,
  normalizeDefaultOpenConnectorRow,
} from "./adapters/provider-port.js";
export type {
  HttpProviderExecutionOptions,
  HttpProviderRuntimeResolver,
} from "./adapters/provider-port.js";
export { ADAPTER_FAILURE_CODES } from "./adapters/types.js";
export type {
  AdapterCapability,
  AdapterExecutionRequest,
  AdapterFailure,
  AdapterFailureCode,
  AdapterResult,
  AdapterSourceBinding,
  CitationFact,
  HttpRequest,
  HttpResponseLike,
  HttpTransport,
  OpenConnectorCapability,
  OpenConnectorNormalizedRow,
  OpenConnectorRowNormalizer,
  OpenConnectorRuntime,
  ProviderResultFact,
  SchemaValidationResult,
  SchemaValidator,
  SchiftSearchCapability,
  SchiftSearchRuntime,
  SourceClass,
} from "./adapters/types.js";

export { KnowledgeScopeStateStore } from "./state-store.js";
export type {
  KnowledgeScopeStateStoreOptions,
  StateStoreFaults,
} from "./state-store.js";
export { KnowledgeScopeAuthorization } from "./authorization.js";
export type { KnowledgeScopeAuthorizationOptions } from "./authorization.js";
export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";
export { createKnowledgeScopeClient, KnowledgeScopeClientError } from "./client.js";
export type { KnowledgeScopeClient } from "./client.js";
export type { RecordsOperationExecutor } from "./adapters/provider-port.js";
export type { OpenConnectorInputMapper, TrustedEffectiveScope } from "./adapters/types.js";
export { evaluateRetrieval, compareRetrievalReports, fingerprintRetrievalDataset, RetrievalEvaluationError } from "./evaluation.js";
export type { RetrievalDataset, RetrievalCapture, RetrievalEvaluationReport } from "./evaluation.js";
export { LocalDocumentStore, LocalDocumentError, LOCAL_LIMITS } from "./local-documents/index.js";
