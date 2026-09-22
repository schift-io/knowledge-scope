import type { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { KnowledgeScopeProductError } from "./errors.js";
import { HttpProviderAdapterError } from "./adapters/provider-port.js";
import { LocalDocumentError } from "./local-documents/files.js";
import { CapabilityBatchExecutionRequestSchema } from "@schift-io/context-pack";
import { AdmitBodySchema, RemoteMountRequestSchema, RunBatchBodySchema, RunBodySchema, UnmountBodySchema, type KnowledgeScopeApplicationPort } from "./api-contract.js";
export type { MountApplicationRequest, RunApplicationRequest, RunBatchApplicationRequest, AdmitApplicationRequest, UnmountApplicationRequest, KnowledgeScopeApplicationPort } from "./api-contract.js";
import { decodeUtf8Strict, parseJsonText, type JsonObject, type JsonValue } from "./json.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
export class KnowledgeScopeApiError extends Error {
  public override readonly name = "KnowledgeScopeApiError";
  public constructor(public readonly code: string, public readonly status: number) { super(code); }
}

type ApiOptions = Readonly<{ application: KnowledgeScopeApplicationPort;
  mountAuthority: JsonValue | (() => Promise<JsonValue>); maxBodyBytes?: number; apiToken?: string }>;
type RouteOptions = Required<Omit<ApiOptions, "apiToken">>;
type Api = Readonly<{ fetch: (request: Request) => Promise<Response> }>;
const jsonResponse = (body: JsonValue, status: number): Response => Response.json(body, { status,
  headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } });
const errorResponse = (code: string, status: number): Response => jsonResponse({ code, status: "error" }, status);
const pathSegments = (pathname: string): readonly string[] => pathname.split("/").filter((segment) => segment.length > 0)
  .map((segment) => decodeURIComponent(segment));
const readBoundedText = async (body: ReadableStream<Uint8Array> | null, maxBytes: number,
  code: string, status: number): Promise<string> => {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return decodeUtf8Strict(Buffer.concat(chunks, size));
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new KnowledgeScopeApiError(code, status); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
};
const assertRequestSecurity = (request: Request, apiToken: string | undefined): void => {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if ((origin !== null && origin !== new URL(request.url).origin) ||
    (fetchSite !== null && fetchSite !== "same-origin")) throw new KnowledgeScopeApiError("cross_site_request", 403);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (request.method === "POST" && mediaType !== "application/json") throw new KnowledgeScopeApiError("content_type_invalid", 415);
  if (apiToken !== undefined) {
    const expected = Buffer.from(`Bearer ${apiToken}`);
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) throw new KnowledgeScopeApiError("authentication_required", 401);
  }
};

const readBody = async (request: Request, maxBodyBytes: number): Promise<JsonValue> => {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBodyBytes) throw new KnowledgeScopeApiError("body_too_large", 413);
  const text = await readBoundedText(request.body, maxBodyBytes, "body_too_large", 413);
  return parseJsonText(text, "request body");
};

const parseBody = async <T>(request: Request, maxBodyBytes: number, schema: z.ZodType<T>): Promise<T> => {
  const result = schema.safeParse(await readBody(request, maxBodyBytes));
  if (!result.success) throw new KnowledgeScopeApiError("request_invalid", 400);
  return result.data;
};

const route = async (request: Request, options: RouteOptions): Promise<Response> => {
  const segments = pathSegments(new URL(request.url).pathname);
  if (segments[0] !== "v1" || segments[1] !== "knowledge-scopes" || segments[2] !== "mounts") {
    return errorResponse("route_not_found", 404);
  }
  if (request.method === "POST" && segments.length === 3) {
    const body = await parseBody(request, options.maxBodyBytes, RemoteMountRequestSchema);
    const scopeAuthority = typeof options.mountAuthority === "function"
      ? await options.mountAuthority() : options.mountAuthority;
    return jsonResponse(await options.application.mount({ ...body, scopeAuthority }), 201);
  }
  const installationSegment = segments[3];
  if (installationSegment === undefined) return errorResponse("route_not_found", 404);
  if (request.method === "GET" && segments.length === 4) {
    return jsonResponse(await options.application.inspect(installationSegment), 200);
  }
  if (request.method !== "POST") return errorResponse("method_not_allowed", 405);
  if (segments.length === 4 && installationSegment.endsWith(":run-batch")) {
    const installationId = installationSegment.slice(0, -":run-batch".length);
    const body = await parseBody(request, options.maxBodyBytes, RunBatchBodySchema);
    const parsed = CapabilityBatchExecutionRequestSchema.safeParse({ ...body, installationId });
    if (!parsed.success) throw new KnowledgeScopeApiError("request_invalid", 400);
    if (options.application.runBatch === undefined) throw new KnowledgeScopeApiError("batch_unsupported", 501);
    return jsonResponse(await options.application.runBatch(parsed.data), 200);
  }
  if (segments.length === 5 && segments[4] === "unmount") {
    const body = await parseBody(request, options.maxBodyBytes, UnmountBodySchema);
    return jsonResponse(await options.application.unmount({ installationId: installationSegment, ...body }), 200);
  }
  if (segments.length === 4 && installationSegment.endsWith(":admit")) {
    const installationId = installationSegment.slice(0, -":admit".length);
    const body = await parseBody(request, options.maxBodyBytes, AdmitBodySchema);
    const candidates = "candidates" in body ? body.candidates : [body.candidate];
    return jsonResponse(await options.application.admit({ installationId, candidates }), 200);
  }
  if (segments.length === 6 && segments[4] === "capabilities" && (segments[5]?.endsWith(":run") ?? false)) {
    const operationId = (segments[5] ?? "").slice(0, -":run".length);
    const body = await parseBody(request, options.maxBodyBytes, RunBodySchema);
    return jsonResponse(await options.application.run({ installationId: installationSegment, operationId, ...body }), 200);
  }
  return errorResponse("route_not_found", 404);
};

export const createKnowledgeScopeApi = (options: ApiOptions): Api => {
  const complete: RouteOptions = {
    application: options.application,
    mountAuthority: options.mountAuthority,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };
  return { fetch: async (request) => {
    try {
      assertRequestSecurity(request, options.apiToken === undefined || options.apiToken.length === 0 ? undefined : options.apiToken);
      return await route(request, complete);
    } catch (error) { // no-excuse-ok: catch -- HTTP trust boundary redacts unexpected failures.
      if (error instanceof KnowledgeScopeApiError) return errorResponse(error.code, error.status);
      if (error instanceof HttpProviderAdapterError) return errorResponse(error.code, 502);
      if (error instanceof LocalDocumentError) return errorResponse(error.code, error.code === "local_snapshot_invalid" ? 503 : 400);
      if (error instanceof KnowledgeScopeProductError) return errorResponse(error.code, 400);
      if (error instanceof SyntaxError || error instanceof URIError) return errorResponse("request_invalid", 400);
      return errorResponse("internal_error", 500);
    }
  } };
};

export type ServedKnowledgeScopeApi = Readonly<{ host: string; port: number; stop: () => void }>;
const requestFromNode = async (request: IncomingMessage, maxBodyBytes: number, port: number): Promise<Request> => {
  const host = request.headers.host?.toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (host === undefined || !allowedHosts.has(host)) throw new KnowledgeScopeApiError("host_invalid", 421);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = typeof rawChunk === "string" ? new TextEncoder().encode(rawChunk) : rawChunk;
    size += chunk.byteLength;
    if (size > maxBodyBytes) throw new KnowledgeScopeApiError("body_too_large", 413);
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method, headers, ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
  });
};

const writeNodeResponse = async (target: ServerResponse, response: Response): Promise<void> => {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await response.arrayBuffer()));
};

export const serveKnowledgeScopeApi = async (options: ApiOptions & Readonly<{ host?: string; port?: number }>): Promise<ServedKnowledgeScopeApi> => {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new KnowledgeScopeApiError("non_loopback_rejected", 400);
  if (options.apiToken === undefined || options.apiToken.length === 0) throw new KnowledgeScopeApiError("api_token_required", 400);
  const api = createKnowledgeScopeApi(options);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer((incoming, outgoing) => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : options.port ?? 8787;
    void requestFromNode(incoming, maxBodyBytes, boundPort)
      .then(api.fetch)
      .then((response) => writeNodeResponse(outgoing, response))
      .catch((error: unknown) => {
        const code = error instanceof KnowledgeScopeApiError ? error.code : "internal_error";
        const status = error instanceof KnowledgeScopeApiError ? error.status : 500;
        void writeNodeResponse(outgoing, errorResponse(code, status));
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 8787;
  return { host, port, stop: () => server.close() };
};

type RequestFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const responseJson = async (response: Response): Promise<JsonValue> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > DEFAULT_MAX_BODY_BYTES) throw new KnowledgeScopeApiError("response_too_large", 502);
  let value: JsonValue;
  try {
    value = parseJsonText(
      await readBoundedText(response.body, DEFAULT_MAX_BODY_BYTES, "response_too_large", 502),
      "HTTP response",
    );
  } catch (error) {
    if (error instanceof KnowledgeScopeProductError) {
      throw new KnowledgeScopeApiError("server_unavailable", 503);
    }
    throw error;
  }
  if (!response.ok) {
    const code = isJsonObject(value) && typeof value["code"] === "string" ? value["code"] : "server_unavailable";
    throw new KnowledgeScopeApiError(code, response.status);
  }
  return value;
};

export const createRemoteKnowledgeScopeApplication = (apiUrl: string, request: RequestFunction = globalThis.fetch,
  apiToken?: string): KnowledgeScopeApplicationPort => {
  if (apiToken === undefined || apiToken.length === 0) throw new KnowledgeScopeApiError("api_token_required", 400);
  const base = new URL(apiUrl);
  const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost" || base.hostname === "[::1]" || base.hostname === "::1";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new KnowledgeScopeApiError("remote_url_insecure", 400);
  }
  const call = async (method: "GET" | "POST", path: string, body?: JsonValue): Promise<JsonValue> => {
    const headers: Record<string, string> = {};
    let serialized: string | undefined;
    if (body !== undefined) headers["content-type"] = "application/json";
    headers["authorization"] = `Bearer ${apiToken}`;
    if (body !== undefined) {
      serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).byteLength > DEFAULT_MAX_BODY_BYTES) throw new KnowledgeScopeApiError("body_too_large", 413);
    }
    let response: Response;
    try {
      response = await request(new URL(path, base), { method, headers,
        ...(serialized === undefined ? {} : { body: serialized }), signal: AbortSignal.timeout(30_000) });
    } catch { // no-excuse-ok: catch -- remote transport details are never exposed.
      throw new KnowledgeScopeApiError("server_unavailable", 503);
    }
    return responseJson(response);
  };
  return {
    mount: ({ scopeAuthority: _trustedLocalAuthority, ...body }) => call("POST", "/v1/knowledge-scopes/mounts", body),
    inspect: (installationId) => call("GET", `/v1/knowledge-scopes/mounts/${encodeURIComponent(installationId)}`),
    runBatch: ({ installationId, ...body }) => call("POST", `/v1/knowledge-scopes/mounts/${encodeURIComponent(installationId)}:run-batch`, parseJsonText(JSON.stringify(body), "batch request")),
    run: ({ installationId, operationId, effectiveScope, input, filters, expectedRevision }) => {
      const body: JsonObject = {
        effectiveScope, input,
        ...(filters === undefined ? {} : { filters }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      };
      return call("POST", `/v1/knowledge-scopes/mounts/${encodeURIComponent(installationId)}/capabilities/${encodeURIComponent(operationId)}:run`, body);
    },
    admit: ({ installationId, candidates }) => call("POST", `/v1/knowledge-scopes/mounts/${encodeURIComponent(installationId)}:admit`, { candidates }),
    unmount: ({ installationId, expectedRevision }) => call("POST", `/v1/knowledge-scopes/mounts/${encodeURIComponent(installationId)}/unmount`, { expectedRevision }),
  };
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
