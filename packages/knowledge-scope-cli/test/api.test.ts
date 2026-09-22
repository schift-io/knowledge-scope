import { describe, expect, it } from "bun:test";

import {
  createKnowledgeScopeApi,
  createRemoteKnowledgeScopeApplication,
  serveKnowledgeScopeApi,
  type KnowledgeScopeApplicationPort,
} from "../src/api.js";
import type { JsonValue } from "../src/json.js";

const application = (): KnowledgeScopeApplicationPort => ({
  mount: async (request) => ({ installationId: "installation-api", request }),
  inspect: async (installationId) => ({ installationId, state: "mounted" }),
  run: async (request) => ({ operationId: request.operationId, candidates: [] }),
  admit: async (request) => ({ candidateCount: request.candidates.length, status: "accepted" }),
  unmount: async () => ({ state: "unmounted" }),
});

const post = (path: string, body: JsonValue): Request => new Request(`http://127.0.0.1${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("Knowledge Scope local API", () => {
  it("routes mount, inspect, run, admit, and unmount through one application", async () => {
    // Given
    const api = createKnowledgeScopeApi({ application: application(), mountAuthority: { organizationId: "org", tenant: "tenant" } });
    const mountBody = { definition: {}, files: {}, lock: {}, sourceBindings: [] };

    // When
    const mounted = await api.fetch(post("/v1/knowledge-scopes/mounts", mountBody));
    const inspected = await api.fetch(new Request("http://127.0.0.1/v1/knowledge-scopes/mounts/installation-api"));
    const run = await api.fetch(post(
      "/v1/knowledge-scopes/mounts/installation-api/capabilities/search-support:run",
      { effectiveScope: { tenant: "acme" }, input: {}, filters: {} },
    ));
    const admitted = await api.fetch(post(
      "/v1/knowledge-scopes/mounts/installation-api:admit",
      { candidates: [{}, {}] },
    ));
    const unmounted = await api.fetch(post(
      "/v1/knowledge-scopes/mounts/installation-api/unmount",
      { expectedRevision: 1 },
    ));

    // Then
    expect([mounted.status, inspected.status, run.status, admitted.status, unmounted.status]).toEqual([201, 200, 200, 200, 200]);
    expect(await admitted.json()).toEqual({ candidateCount: 2, status: "accepted" });
  });

  it("wraps the legacy singular candidate but rejects mixed or unknown admission fields", async () => {
    // Given
    const api = createKnowledgeScopeApi({ application: application(), mountAuthority: {} });

    // When
    const legacy = await api.fetch(post(
      "/v1/knowledge-scopes/mounts/installation-api:admit",
      { candidate: {} },
    ));
    const mixed = await api.fetch(post(
      "/v1/knowledge-scopes/mounts/installation-api:admit",
      { candidate: {}, candidates: [{}] },
    ));
    const unknown = await api.fetch(post(
      "/v1/knowledge-scopes/mounts/installation-api:admit",
      { candidates: [{}], authorizationDecision: "caller-owned" },
    ));
    const oversized = await api.fetch(post(
      "/v1/knowledge-scopes/mounts/installation-api:admit",
      { candidates: Array.from({ length: 101 }, (_, index) => ({ index })) },
    ));

    // Then
    expect(await legacy.json()).toEqual({ candidateCount: 1, status: "accepted" });
    expect([mixed.status, unknown.status, oversized.status]).toEqual([400, 400, 400]);
  });

  it("rejects unknown request fields before the application is called", async () => {
    // Given
    let calls = 0;
    const base = application();
    const api = createKnowledgeScopeApi({ application: { ...base, unmount: async (request) => {
      calls += 1;
      return base.unmount(request);
    } }, mountAuthority: { organizationId: "org", tenant: "tenant" } });

    // When
    const response = await api.fetch(post(
      "/v1/knowledge-scopes/mounts/installation-api/unmount",
      { expectedRevision: 1, credential: "must-not-pass" },
    ));

    // Then
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
    expect(await response.json()).toEqual({ code: "request_invalid", status: "error" });
  });

  it("rejects caller-supplied mount authority", async () => {
    // Given
    let calls = 0;
    const base = application();
    const api = createKnowledgeScopeApi({
      application: { ...base, mount: async (request) => { calls += 1; return base.mount(request); } },
      mountAuthority: { organizationId: "trusted-org", tenant: "trusted-tenant" },
    });

    // When
    const response = await api.fetch(post("/v1/knowledge-scopes/mounts", {
      definition: {}, files: {}, lock: {}, sourceBindings: [],
      scopeAuthority: { organizationId: "attacker", tenant: "attacker" },
    }));

    // Then
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("rejects request bodies over the configured limit", async () => {
    // Given
    const api = createKnowledgeScopeApi({ application: application(), mountAuthority: {}, maxBodyBytes: 32 });

    // When
    const response = await api.fetch(post(
      "/v1/knowledge-scopes/mounts/installation-api:admit",
      { candidate: { payload: "x".repeat(64) } },
    ));

    // Then
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "body_too_large", status: "error" });
  });

  it("does not expose wildcard CORS headers", async () => {
    // Given
    const api = createKnowledgeScopeApi({ application: application(), mountAuthority: {} });

    // When
    const response = await api.fetch(new Request("http://127.0.0.1/v1/knowledge-scopes/mounts/installation-api"));

    // Then
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("maps malformed encoded paths to a redacted client error", async () => {
    // Given
    const api = createKnowledgeScopeApi({ application: application(), mountAuthority: {} });

    // When
    const response = await api.fetch(new Request("http://127.0.0.1/v1/knowledge-scopes/mounts/%E0%A4%A"));

    // Then
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "request_invalid", status: "error" });
  });

  it("serves the same wire over a real loopback HTTP round trip", async () => {
    // Given
    const server = await serveKnowledgeScopeApi({
      application: application(),
      mountAuthority: { organizationId: "trusted-org", tenant: "trusted-tenant" },
      port: 0,
      apiToken: "loopback-secret",
    });
    const remote = createRemoteKnowledgeScopeApplication(`http://${server.host}:${server.port}`, fetch, "loopback-secret");

    try {
      // When
      const result = await remote.inspect("installation-api");

      // Then
      expect(result).toEqual({ installationId: "installation-api", state: "mounted" });
    } finally {
      server.stop();
    }
  });

  it("rejects every direct non-loopback listener even with a token", async () => {
    // Given
    const start = () => serveKnowledgeScopeApi({
      application: application(),
      mountAuthority: {},
      host: "0.0.0.0",
      port: 0,
      apiToken: "unused-secret",
    });

    // When / Then
    expect(start()).rejects.toMatchObject({ code: "non_loopback_rejected" });
  });

  it("rejects non-JSON and cross-origin mutations over real HTTP", async () => {
    // Given
    const server = await serveKnowledgeScopeApi({
      application: application(),
      mountAuthority: {},
      port: 0,
      apiToken: "loopback-secret",
    });
    const endpoint = `http://${server.host}:${server.port}/v1/knowledge-scopes/mounts/installation-api/unmount`;

    try {
      // When
      const plain = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: "Bearer loopback-secret", "content-type": "text/plain" },
        body: JSON.stringify({ expectedRevision: 1 }),
      });
      const crossOrigin = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer loopback-secret",
          origin: "https://attacker.invalid",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ expectedRevision: 1 }),
      });

      // Then
      expect(plain.status).toBe(415);
      expect(await plain.json()).toEqual({ code: "content_type_invalid", status: "error" });
      expect(crossOrigin.status).toBe(403);
      expect(await crossOrigin.json()).toEqual({ code: "cross_site_request", status: "error" });
    } finally {
      server.stop();
    }
  });

  it("requires a token before exposing even a loopback listener", async () => {
    // Given
    const start = () => serveKnowledgeScopeApi({
      application: application(),
      mountAuthority: {},
      port: 0,
    });

    // When / Then
    expect(start()).rejects.toMatchObject({ code: "api_token_required" });
  });

  it("authenticates every served loopback request", async () => {
    // Given
    const server = await serveKnowledgeScopeApi({
      application: application(),
      mountAuthority: {},
      port: 0,
      apiToken: "server-secret-token",
    });
    const endpoint = `http://127.0.0.1:${server.port}/v1/knowledge-scopes/mounts/installation-api`;
    const remote = createRemoteKnowledgeScopeApplication(`http://127.0.0.1:${server.port}`, fetch, "server-secret-token");

    try {
      // When
      const missing = await fetch(endpoint);
      const wrong = await fetch(endpoint, { headers: { authorization: "Bearer wrong-token" } });
      const accepted = await fetch(endpoint, { headers: { authorization: "Bearer server-secret-token" } });
      const remoteResult = await remote.inspect("installation-api");

      // Then
      expect([missing.status, wrong.status, accepted.status]).toEqual([401, 401, 200]);
      expect(await missing.json()).toEqual({ code: "authentication_required", status: "error" });
      expect(await wrong.json()).toEqual({ code: "authentication_required", status: "error" });
      expect(remoteResult).toEqual({ installationId: "installation-api", state: "mounted" });
    } finally {
      server.stop();
    }
  });

  it("rejects DNS-rebinding Host and Origin values before invoking the application", async () => {
    // Given
    let calls = 0;
    const base = application();
    const server = await serveKnowledgeScopeApi({
      application: { ...base, inspect: async (installationId) => { calls += 1; return base.inspect(installationId); } },
      mountAuthority: {},
      port: 0,
      apiToken: "server-secret-token",
    });
    const attackerOrigin = `http://attacker.example:${server.port}`;

    try {
      // When
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/knowledge-scopes/mounts/installation-api`, {
        headers: {
          authorization: "Bearer server-secret-token",
          host: `attacker.example:${server.port}`,
          origin: attackerOrigin,
          "sec-fetch-site": "same-origin",
        },
      });

      // Then
      expect(response.status).toBe(421);
      expect(await response.json()).toEqual({ code: "host_invalid", status: "error" });
      expect(calls).toBe(0);
    } finally {
      server.stop();
    }
  });

  it("requires a remote token and HTTPS outside loopback", () => {
    // Given / When / Then
    expect(() => createRemoteKnowledgeScopeApplication("http://127.0.0.1:8787"))
      .toThrow("api_token_required");
    expect(() => createRemoteKnowledgeScopeApplication("http://example.com", fetch, "secret"))
      .toThrow("remote_url_insecure");
    expect(() => createRemoteKnowledgeScopeApplication("https://example.com", fetch, "secret"))
      .not.toThrow();
  });

  it("maps remote transport failures to a stable redacted unavailable error", async () => {
    // Given
    const remote = createRemoteKnowledgeScopeApplication(
      "http://127.0.0.1:8787",
      async () => { throw new Error("socket details must not escape"); },
      "client-secret",
    );

    // When / Then
    await expect(remote.inspect("installation-api")).rejects.toMatchObject({
      code: "server_unavailable",
      status: 503,
      message: "server_unavailable",
    });
  });

  it("maps malformed remote bytes and JSON to a stable unavailable error", async () => {
    // Given
    const malformedUtf8 = createRemoteKnowledgeScopeApplication(
      "http://127.0.0.1:8787",
      async () => new Response(new Uint8Array([0xff]), { status: 200 }),
      "client-secret",
    );
    const malformedJson = createRemoteKnowledgeScopeApplication(
      "http://127.0.0.1:8787",
      async () => new Response("not-json", { status: 200 }),
      "client-secret",
    );

    // When / Then
    await expect(malformedUtf8.inspect("installation-api")).rejects.toMatchObject({
      code: "server_unavailable",
      status: 503,
    });
    await expect(malformedJson.inspect("installation-api")).rejects.toMatchObject({
      code: "server_unavailable",
      status: 503,
    });
  });

  it("caps outbound and inbound remote payloads before returning data", async () => {
    // Given
    let calls = 0;
    const oversizedResponse = createRemoteKnowledgeScopeApplication(
      "http://127.0.0.1:8787",
      async () => {
        calls += 1;
        return new Response(JSON.stringify({ value: "x".repeat(1_048_576) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      "client-secret",
    );
    const oversizedRequest = createRemoteKnowledgeScopeApplication(
      "http://127.0.0.1:8787",
      async () => { calls += 1; return Response.json({ status: "unexpected" }); },
      "client-secret",
    );

    // When / Then
    await expect(oversizedResponse.inspect("installation-api")).rejects.toMatchObject({ code: "response_too_large" });
    await expect(oversizedRequest.admit({
      installationId: "installation-api",
      candidates: [{ payload: "x".repeat(1_048_576) }],
    })).rejects.toMatchObject({ code: "body_too_large" });
    expect(calls).toBe(1);
  });
});
