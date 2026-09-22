import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { JsonValue } from "../src/json.js"
import {
  SENTINEL_TOKEN,
  createWorkspace,
  parseOutput,
  requireObject,
  requireBuiltCli,
  runCli,
  startProviderServer,
  type CliResult,
  type E2eWorkspace,
  type ProviderServer,
} from "./fixtures/cli-e2e-harness.js"

let provider: ProviderServer
let workspace: E2eWorkspace | undefined

beforeAll(async () => {
  await requireBuiltCli()
  provider = startProviderServer()
})

afterAll(async () => {
  if (provider !== undefined) provider.stop()
  if (workspace !== undefined) await workspace.cleanup()
})

const requireCandidate = (value: JsonValue): JsonValue => {
  const output = requireObject(value)
  const candidates = output["candidates"]
  if (!Array.isArray(candidates) || candidates.length !== 1) {
    throw new TypeError("expected exactly one candidate")
  }
  const candidate = candidates[0]
  if (candidate === undefined) throw new TypeError("candidate is missing")
  return candidate
}

const combinedOutput = (results: readonly CliResult[]): string =>
  results.map((result) => `${result.stdout}\n${result.stderr}`).join("\n")

describe("standalone Knowledge Scope CLI developer path", () => {
  test("persists two provider-backed capabilities and denies them after unmount", async () => {
    // Given
    workspace = await createWorkspace(provider.baseUrl)
    const results: CliResult[] = [workspace.init]
    expect(workspace.init.exitCode).toBe(0)
    expect(parseOutput(workspace.init)).toMatchObject({ status: "initialized" })

    const initialValidation = await runCli(["validate", workspace.portable], workspace.environment)
    results.push(initialValidation)
    expect(parseOutput(initialValidation)).toEqual({ definitionDigest: null, lockVerified: false, status: "valid" })

    const locked = await runCli(["lock", workspace.portable], workspace.environment)
    results.push(locked)
    expect(locked.exitCode).toBe(0)
    expect(parseOutput(locked)).toMatchObject({ status: "locked" })

    const lockedValidation = await runCli(["validate", workspace.portable], workspace.environment)
    results.push(lockedValidation)
    expect(parseOutput(lockedValidation)).toMatchObject({ lockVerified: true, status: "valid" })

    const mounted = await runCli(
      ["mount", workspace.portable, "--bindings", workspace.bindings],
      workspace.environment,
    )
    results.push(mounted)
    const mountOutput = requireObject(parseOutput(mounted))
    const installationId = mountOutput["installationId"]
    const revision = mountOutput["revision"]
    if (typeof installationId !== "string" || typeof revision !== "number") {
      throw new TypeError("mount output is malformed")
    }

    const inspected = await runCli(["inspect", installationId], workspace.environment)
    results.push(inspected)
    expect(parseOutput(inspected)).toMatchObject({
      definition: { packId: "full-scope" },
      mount: { installationId, revision, state: "mounted" },
    })

    // When
    const connectorRun = await runCli(
      ["run", installationId, "fetch-support", "--input", workspace.input],
      workspace.environment,
    )
    const searchRun = await runCli(
      ["run", installationId, "search-handbook", "--input", workspace.input],
      workspace.environment,
    )
    results.push(connectorRun, searchRun)
    expect(connectorRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(searchRun).toMatchObject({ exitCode: 0, stderr: "" })
    const connectorCandidate = requireCandidate(parseOutput(connectorRun))
    const searchCandidate = requireCandidate(parseOutput(searchRun))

    // Then
    expect(parseOutput(connectorRun)).toMatchObject({ status: "ready", receipt: { status: "ready" } })
    expect(parseOutput(searchRun)).toMatchObject({ status: "ready", receipt: { status: "ready" } })
    expect(provider.requests).toEqual([
      "/v1/actions/support-search",
      "/v2/buckets/support-handbook/search/status",
      "/v2/buckets/support-handbook/retrieve",
    ])

    const candidatePath = join(workspace.root, "candidates.json")
    await writeFile(candidatePath, JSON.stringify([connectorCandidate, searchCandidate]))
    const aggregateAdmission = await runCli(
      ["admit", installationId, "--candidate", candidatePath],
      workspace.environment,
    )
    results.push(aggregateAdmission)
    const aggregateOutput = requireObject(parseOutput(aggregateAdmission))
    const acceptedReceipts = aggregateOutput["candidateReceipts"]
    expect(aggregateOutput).toMatchObject({ status: "ready" })
    expect(Array.isArray(acceptedReceipts) ? acceptedReceipts : []).toHaveLength(2)
    expect(acceptedReceipts).toEqual([
      expect.objectContaining({ status: "accepted" }),
      expect.objectContaining({ status: "accepted" }),
    ])

    const unmounted = await runCli(
      ["unmount", installationId, "--expected-revision", String(revision)],
      workspace.environment,
    )
    results.push(unmounted)
    expect(parseOutput(unmounted)).toMatchObject({ state: "unmounted", revision: revision + 1 })

    const rerun = await runCli(
      ["run", installationId, "fetch-support", "--input", workspace.input],
      workspace.environment,
    )
    results.push(rerun)
    expect(rerun.exitCode).toBe(1)
    expect(rerun.stdout).toBe("")
    expect(JSON.parse(rerun.stderr)).toEqual({ code: "installation_not_mounted", status: "error" })

    const admission = await runCli(
      ["admit", installationId, "--candidate", candidatePath],
      workspace.environment,
    )
    results.push(admission)
    expect(parseOutput(admission)).toMatchObject({
      status: "insufficient_evidence",
      candidateReceipts: [
        { status: "denied", reasonCode: "installation_not_mounted" },
        { status: "denied", reasonCode: "installation_not_mounted" },
      ],
    })
    expect(admission.stdout).not.toContain("\"payload\"")
    expect(admission.stdout).not.toContain("\"candidates\"")
    expect(JSON.stringify(searchCandidate)).toContain("Handbook evidence")

    const persistedState = await readFile(join(workspace.home, "state.json"), "utf8")
    expect(combinedOutput(results)).not.toContain(SENTINEL_TOKEN)
    expect(persistedState).not.toContain(SENTINEL_TOKEN)
  })
})
