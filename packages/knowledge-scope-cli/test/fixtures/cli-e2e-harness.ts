import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { parseJsonText, type JsonObject, type JsonValue } from "../../src/json.js"

const PACKAGE_ROOT = resolve(import.meta.dir, "../..")
const DIST_MAIN = join(PACKAGE_ROOT, "dist/main.js")
const FULL_SCOPE = join(import.meta.dir, "full-scope")

export const SENTINEL_TOKEN = "e2e-sentinel-token-never-print"

export type CliResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

export type ProviderScenario = Readonly<{
  actionId?: string
  auditPersisted?: boolean
  executionId?: string
  openFreshness?: string
  searchBucket?: string
  searchFreshness?: string
  oversizedOpen?: boolean
}>

export type ProviderServer = Readonly<{
  baseUrl: string
  requests: readonly string[]
  stop: () => void
}>

export type E2eWorkspace = Readonly<{
  root: string
  home: string
  portable: string
  bindings: string
  input: string
  environment: Readonly<Record<string, string>>
  init: CliResult
  cleanup: () => Promise<void>
}>

export class E2eHarnessError extends Error {
  public override readonly name = "E2eHarnessError"
  public constructor(public readonly code: string) { super(code) }
}

export const requireBuiltCli = (): Promise<void> => access(DIST_MAIN)

export const runCli = async (
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<CliResult> => {
  const spawned = Bun.spawn([process.execPath, DIST_MAIN, ...args], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    spawned.exited,
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

export const parseOutput = (result: CliResult): JsonValue =>
  parseJsonText(result.stdout, "CLI stdout")

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export const requireObject = (value: JsonValue): JsonObject => {
  if (!isJsonObject(value)) throw new E2eHarnessError("output_not_object")
  return value
}

export const createWorkspace = async (baseUrl: string): Promise<E2eWorkspace> => {
  const root = await mkdtemp(join(tmpdir(), "schift-ks-e2e-"))
  const home = join(root, "home")
  const portable = join(root, "portable")
  const bindings = join(root, "bindings.json")
  const input = join(root, "input.json")
  const environment = {
    SCHIFT_KS_HOME: home,
    SCHIFT_KS_OPEN_CONNECTOR_READ_ACTIONS: JSON.stringify([{
      connectorRef: "helpdesk",
      connectorAlias: "helpdesk",
      actionId: "support-search",
    }]),
    SCHIFT_KS_OPEN_CONNECTOR_SCOPES: "tickets:read",
    SCHIFT_KS_OPEN_CONNECTOR_TOKEN: SENTINEL_TOKEN,
    SCHIFT_KS_OPEN_CONNECTOR_URL: baseUrl,
    SCHIFT_KS_SEARCH_ORGANIZATION_ID: "acme-org",
    SCHIFT_KS_SEARCH_SCOPES: "search:read",
    SCHIFT_KS_SEARCH_TOKEN: SENTINEL_TOKEN,
    SCHIFT_KS_SEARCH_URL: baseUrl,
  }
  const init = await runCli(["init", portable], environment)
  await cp(join(FULL_SCOPE, "scope.json"), join(portable, "scope.json"))
  await mkdir(join(portable, "schemas"))
  await cp(join(FULL_SCOPE, "schemas"), join(portable, "schemas"), { recursive: true })
  await cp(join(FULL_SCOPE, "bindings.json"), bindings)
  await writeFile(input, JSON.stringify({ effectiveScope: { tenant: "acme" }, input: { query: "refund" } }))
  return {
    root, home, portable, bindings, input, environment, init,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  }
}

export const mountWorkspace = async (
  baseUrl: string,
): Promise<E2eWorkspace & Readonly<{ installationId: string; revision: number }>> => {
  const workspace = await createWorkspace(baseUrl)
  const locked = await runCli(["lock", workspace.portable], workspace.environment)
  if (locked.exitCode !== 0) throw new E2eHarnessError(`lock_failed:${locked.stderr}`)
  const mounted = await runCli(
    ["mount", workspace.portable, "--bindings", workspace.bindings],
    workspace.environment,
  )
  const output = requireObject(parseOutput(mounted))
  const installationId = output["installationId"]
  const revision = output["revision"]
  if (typeof installationId !== "string" || typeof revision !== "number") {
    throw new E2eHarnessError("mount_output_invalid")
  }
  return { ...workspace, installationId, revision }
}

export const startProviderServer = (scenario: ProviderScenario = {}): ProviderServer => {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === "/v1/actions/support-search") {
        await request.json()
        const payload = scenario.oversizedOpen ? "x".repeat(4_096) : "Connector evidence"
        return Response.json({
          success: true,
          message: "OK",
          data: [{
            resultId: "ticket-1",
            revision: "ticket-revision-1",
            freshness: scenario.openFreshness ?? new Date().toISOString(),
            payload: { text: payload },
            citation: { uri: "https://support.example.test/tickets/1" },
          }],
          meta: {
            actionId: scenario.actionId ?? "support-search",
            executionId: scenario.executionId ?? "connector-run-1",
            auditPersisted: scenario.auditPersisted ?? true,
          },
        })
      }
      const bucket = scenario.searchBucket ?? "support-handbook"
      if (path.endsWith("/search/status")) {
        return Response.json({
          status: "ready", operational_status: "ready", bucket_id: bucket,
          last_indexed_at: scenario.searchFreshness ?? new Date().toISOString(),
        })
      }
      if (path.endsWith("/retrieve")) {
        const body: unknown = await request.json()
        return Response.json({
          status: "ready", operational_status: "ready", bucket_id: bucket,
          query: "refund", body,
          results: [{
            chunk_id: "chunk-1", document_id: "document-1", source_id: "source-1",
            text: "Handbook evidence", score: 0.98,
            metadata: { source_url: "https://docs.example.test/handbook/refunds" },
          }],
        })
      }
      return Response.json({ status: "not_found" }, { status: 404 })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}
