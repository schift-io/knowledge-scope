import { expect, it } from "bun:test";
import { displayResult, displayError } from "../src/cli-display.js";

it("makes cleanup preview non-destructive and preserves the selected plan in its next command", () => {
  // Given: two old revisions are proposed, not deleted.
  const value = { status: "preview", plan: "a".repeat(64), keep: 2, obsoleteInstallations: ["ks-old-a", "ks-old-b"], bytes: 4200, retainedSharedRefs: [] };
  // When
  const output = displayResult(value, "chosen project");
  // Then
  expect(output).toContain("Nothing deleted");
  expect(output).toContain("--plan");
  expect(output).toContain("--project 'chosen project'");
  expect(output).toContain("--keep 2");
  expect(output.split("\n").every((line) => line.length <= 80)).toBe(true);
});

it("makes legacy recovery require a stopped-writer assertion", () => {
  // Given / When
  const output = displayResult({ status: "recovery_preview", plan: "b".repeat(64), locks: [{ path: "private", state: "legacy" }] }, ".schift-ks");
  // Then
  expect(output).toContain("Stop all KS writers");
  expect(output).toContain("--quiesced");
  expect(output).toContain("Nothing changed");
  expect(output.split("\n").every((line) => line.length <= 80)).toBe(true);
});

it("does not tell operators to retry a possibly committed write blindly", () => {
  // Given / When
  const output = displayError("commit_uncertain", ".schift-ks");
  // Then
  expect(output).toContain("may have completed");
  expect(output).toContain("Do not delete");
});

it("does not hide incomplete builds when no old connection needs deletion", () => {
  // Given / When
  const output = displayResult({ status: "preview", plan: "c".repeat(64), keep: 2,
    obsoleteInstallations: [], failedBuilds: ["owned-build"], bytes: 12, retainedSharedRefs: [] }, ".schift-ks");
  // Then
  expect(output).toContain("Incomplete builds: 1");
  expect(output).toContain("--plan");
});
