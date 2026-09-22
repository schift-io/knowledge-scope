import { afterEach, expect, it } from "bun:test";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeScopeDefinitionSchema, KnowledgeScopeMountSchema, CapabilityExecutionRequestSchema } from "@schift-io/context-pack";
import { LocalDocumentStore } from "../src/local-documents/index.js";
import type { ProviderExecutionContext } from "../src/application-execution.js";
import definitionFixture from "../../context-pack/fixtures/knowledge-scope/valid-definition.json";
import mountFixture from "../../context-pack/fixtures/knowledge-scope/valid-mount.json";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "ks-local-execution-")); roots.push(root);
  const source = join(root, "policy.md"); await writeFile(source, "# 환불 규정\nRefunds within 30 days.");
  const store = new LocalDocumentStore({ home: join(root, "state") });
  const ingestion = await store.ingest(source);
  const definition = KnowledgeScopeDefinitionSchema.parse({ ...definitionFixture, capabilities: [{
    operationId: "search.docs", provider: { kind: "local_documents", indexRef: ingestion.indexRef },
    inputSchemaRef: "schemas/input.json", resultSchemaRef: "schemas/result.json",
  }] });
  const mount = KnowledgeScopeMountSchema.parse({ ...mountFixture, sourceBindings: [{ sourceId: "product.manuals", sourceClass: "document",
    providerRef: ingestion.indexRef, authority: "approved", permissionMode: "static", operationIds: ["search.docs"] }] });
  const capability = definition.capabilities[0]; const binding = mount.sourceBindings[0];
  if (capability === undefined || binding === undefined) throw new Error("fixture missing");
  const context: ProviderExecutionContext = { definition, mount, capability, binding,
    request: CapabilityExecutionRequestSchema.parse({ installationId: mount.installationId, operationId: "search.docs", effectiveScope: { tenant: mount.scopeAuthority.tenant }, input: { query: "refunds" } }),
    validateInput: () => ({ valid: true }), validateResult: () => ({ valid: true }) };
  return { store, source, context, ingestion };
};
it("returns source text with line citation and content revision", async () => {
  // Given
  const { store, context } = await fixture();
  // When
  const results = await store.execute(context);
  // Then
  expect(results).toHaveLength(1);
  expect(results[0]?.citation?.uri).toMatch(/^schift:\/\/local-documents\/local:[a-f0-9]{64}\/doc:[a-f0-9]{64}#L1-L2$/);
  expect(results[0]?.citation?.label).toBe("policy.md:L1-L2");
  expect(results[0]?.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
});
it("returns no evidence when no lexical terms match", async () => {
  // Given
  const { store, context } = await fixture();
  // When
  const results = await store.execute({ ...context, request: { ...context.request, input: { query: "elephant" } } });
  // Then
  expect(results).toEqual([]);
});
it("matches Korean terms without sending source data to a model", async () => {
  // Given
  const { store, context } = await fixture();
  // When
  const results = await store.execute({ ...context, request: { ...context.request, input: { query: "환불은" } } });
  // Then
  expect(results).toHaveLength(1);
});
it("keeps captured text and freshness when source changes", async () => {
  // Given
  const { store, source, context } = await fixture(); const before = await store.execute(context);
  await writeFile(source, "Changed policy");
  // When
  const after = await store.execute(context);
  // Then
  expect(after).toEqual(before);
});
it("rejects tampered snapshot bytes", async () => {
  // Given
  const { store, context, ingestion } = await fixture();
  await writeFile(join(store.home, "local-documents", `${ingestion.indexRef.slice(6)}.json`), "{}");
  // When / Then
  await expect(store.execute(context)).rejects.toThrow();
});
it("rejects world-readable snapshot storage", async () => {
  // Given
  const { store, context } = await fixture(); await chmod(join(store.home, "local-documents"), 0o755);
  // When / Then
  await expect(store.execute(context)).rejects.toThrow();
});
it("rejects filters, foreign tenants and narrowed scopes rather than dropping them", async () => {
  // Given
  const { store, context } = await fixture();
  // When / Then
  await expect(store.execute({ ...context, request: { ...context.request, filters: { locale: "ko" } } })).rejects.toThrow();
  await expect(store.execute({ ...context, request: { ...context.request, effectiveScope: { tenant: "another" } } })).rejects.toThrow();
  await expect(store.execute({ ...context, request: { ...context.request, effectiveScope: { ...context.request.effectiveScope, namespace: "narrow" } } })).rejects.toThrow();
});
