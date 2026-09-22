import { expect, it } from "bun:test";
import { displayError, displayResult, FIRST_USE_HELP } from "../src/cli-display.js";

it("escapes terminal controls in source names and snippets", () => {
  // Given
  const value = { status: "ready", candidates: [{ payload: { text: "safe\u001b[2J\rspoof" }, citation: { label: "x\u202e.md", uri: "schift://x\u009b2J" } }] };
  // When
  const output = displayResult(value, ".schift-ks");
  // Then
  expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/u);
  expect(output).toContain("\\u001b");
  expect(output).toContain("\\u202e");
});

it("keeps source paths inert in copyable follow-up commands", () => {
  // Given
  const directory = "project's $(touch surprise)";
  // When
  const output = displayResult({ status: "connected", source: "notes\nspoof" }, directory);
  // Then
  expect(output).toContain("notes\\u000aspoof");
  expect(output).toContain("--project 'project'\\''s $(touch surprise)'");
});

it("does not call missing matches stale or invent an answer", () => {
  // Given
  const value = { status: "insufficient_evidence", candidates: [] };
  // When
  const output = displayResult(value, "chosen");
  // Then
  expect(output).toContain("No sufficient evidence");
  expect(output).toContain("If documents changed or expired");
  expect(output).toContain("schift-ks refresh --project 'chosen'");
});

it("does not suggest restoring access when a binding cannot be verified", () => {
  // Given / When
  const output = displayError("installation_mismatch", ".schift-ks");
  // Then
  expect(output).toContain("do not reuse its evidence");
  expect(output).not.toContain("refresh");
});

it("offers refresh when evidence was denied as stale", () => {
  // Given
  const value = { status: "insufficient_evidence", candidates: [], nextAction: "Refresh the selected project." };
  // When
  const output = displayResult(value, "chosen");
  // Then
  expect(output).toContain("have expired");
  expect(output).toContain("schift-ks refresh --project 'chosen'");
});

it("keeps multiline evidence readable as indented quotations", () => {
  // Given
  const value = { status: "ready", candidates: [{ payload: { text: "# Refund policy\nRefund within 14 days.\n\nKeep the receipt." } }] };
  // When
  const output = displayResult(value, ".schift-ks");
  // Then
  expect(output).toContain("  # Refund policy\n  Refund within 14 days.\n  \n  Keep the receipt.");
  expect(output).not.toContain("\\u000a");
});

it("wraps long English and Korean excerpts within eighty columns", () => {
  // Given
  const value = { status: "ready", candidates: [{ payload: { text: `${"Refund available. ".repeat(20)}\n${"환불규정".repeat(40)}` } }] };
  // When
  const output = displayResult(value, ".schift-ks");
  // Then
  const quotes = output.split("\n").filter((line) => line.startsWith("  "));
  expect(quotes.length).toBeGreaterThan(4);
  for (const line of quotes) {
    const width = Array.from(line).reduce((sum, character) => sum + (/[가-힣]/u.test(character) ? 2 : 1), 0);
    expect(width).toBeLessThanOrEqual(80);
  }
});

it("keeps full citation identifiers out of the human reading path", () => {
  // Given
  const uri = `schift://local-documents/${"a".repeat(64)}/doc:${"b".repeat(64)}#L1-L2`;
  const value = { status: "ready", candidates: [{ payload: { text: "Refund policy." }, citation: { label: "refund.md:L1-L2", uri } }] };
  // When
  const output = displayResult(value, ".schift-ks");
  // Then
  expect(output).toContain("refund.md:L1-L2");
  expect(output).not.toContain(uri);
  expect(output).toContain("--json for full citation details");
  expect(Math.max(...output.split("\n").map((line) => line.length))).toBeLessThanOrEqual(80);
});

it("fits first-use help within eighty columns", () => {
  // Given / When / Then
  expect(Math.max(...FIRST_USE_HELP.split("\n").map((line) => line.length))).toBeLessThanOrEqual(80);
});
