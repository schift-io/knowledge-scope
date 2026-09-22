import { beforeAll, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  SENTINEL_TOKEN,
  createWorkspace,
  mountWorkspace,
  requireBuiltCli,
  runCli,
  startProviderServer,
  type CliResult,
  type ProviderScenario,
} from "./fixtures/cli-e2e-harness.js"

beforeAll(requireBuiltCli)

const expectClosed = (result: CliResult, code: string): void => {
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe("")
  expect(JSON.parse(result.stderr)).toEqual({ code, status: "error" })
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("\"candidates\"")
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(SENTINEL_TOKEN)
}

const runFailure = async (
  scenario: ProviderScenario,
  operationId: "fetch-support" | "search-handbook",
): Promise<CliResult> => {
  const provider = startProviderServer(scenario)
  const workspace = await mountWorkspace(provider.baseUrl)
  try {
    return await runCli(
      ["run", workspace.installationId, operationId, "--input", workspace.input],
      workspace.environment,
    )
  } finally {
    await workspace.cleanup()
    provider.stop()
  }
}

describe("standalone Knowledge Scope CLI fail-closed boundaries", () => {
  test("rejects a portable whose locked schema was tampered", async () => {
    // Given
    const provider = startProviderServer()
    const workspace = await createWorkspace(provider.baseUrl)
    try {
      const locked = await runCli(["lock", workspace.portable], workspace.environment)
      expect(locked.exitCode).toBe(0)
      await writeFile(join(workspace.portable, "schemas/query.json"), JSON.stringify({
        additionalProperties: false,
        properties: { query: { minLength: 2, type: "string" } },
        required: ["query"],
        type: "object",
      }))

      // When
      const result = await runCli(
        ["mount", workspace.portable, "--bindings", workspace.bindings],
        workspace.environment,
      )

      // Then
      expectClosed(result, "lock_invalid")
      expect(provider.requests).toEqual([])
    } finally {
      await workspace.cleanup()
      provider.stop()
    }
  })

  test("rejects an effective Scope wider than the mounted tenant", async () => {
    // Given
    const provider = startProviderServer()
    const workspace = await mountWorkspace(provider.baseUrl)
    try {
      const widened = join(workspace.root, "widened.json")
      await writeFile(widened, JSON.stringify({
        effectiveScope: { tenant: "other-tenant" },
        input: { query: "refund" },
      }))

      // When
      const result = await runCli(
        ["run", workspace.installationId, "fetch-support", "--input", widened],
        workspace.environment,
      )

      // Then
      expectClosed(result, "scope_invalid")
      expect(provider.requests).toEqual([])
    } finally {
      await workspace.cleanup()
      provider.stop()
    }
  })

  test("rejects stale connector evidence before Candidate output", async () => {
    // Given / When
    const result = await runFailure({ openFreshness: "2000-01-01T00:00:00.000Z" }, "fetch-support")

    // Then
    expectClosed(result, "result_stale")
  })

  test("rejects future connector evidence before Candidate output", async () => {
    // Given / When
    const result = await runFailure({ openFreshness: "2999-01-01T00:00:00.000Z" }, "fetch-support")

    // Then
    expectClosed(result, "invalid_freshness")
  })

  test("rejects an undeclared operation before provider dispatch", async () => {
    // Given
    const provider = startProviderServer()
    const workspace = await mountWorkspace(provider.baseUrl)
    try {
      // When
      const result = await runCli(
        ["run", workspace.installationId, "delete-everything", "--input", workspace.input],
        workspace.environment,
      )

      // Then
      expectClosed(result, "capability_not_found")
      expect(provider.requests).toEqual([])
    } finally {
      await workspace.cleanup()
      provider.stop()
    }
  })

  test("rejects a mismatched Open Connector action identity", async () => {
    // Given / When
    const result = await runFailure({ actionId: "different-action" }, "fetch-support")

    // Then
    expectClosed(result, "provider_identity_mismatch")
  })

  test("rejects a mismatched Schift Search bucket identity", async () => {
    // Given / When
    const result = await runFailure({ searchBucket: "different-bucket" }, "search-handbook")

    // Then
    expectClosed(result, "provider_identity_mismatch")
  })

  test("rejects connector evidence without persisted audit correlation", async () => {
    // Given / When
    const result = await runFailure({ auditPersisted: false }, "fetch-support")

    // Then
    expectClosed(result, "provider_identity_mismatch")
  })

  test("rejects an oversized provider response before Candidate output", async () => {
    // Given / When
    const result = await runFailure({ oversizedOpen: true }, "fetch-support")

    // Then
    expectClosed(result, "response_too_large")
  })
})
