import { expect, it } from "bun:test";
import { parseCliOptions } from "../src/cli-options.js";

it("accepts a non-mutating cleanup preview and an explicitly plan-bound apply", () => {
  // Given: an operator reviewed a cleanup plan for one selected project.
  const plan = "a".repeat(64);
  // When / Then: preview needs no deletion permission, but apply names its plan.
  expect(parseCliOptions("prune", ["--project", "./notes", "--keep", "2"])).toEqual([]);
  expect(parseCliOptions("prune", ["--apply", "--plan", plan, "--json"])).toEqual([]);
});

it("requires explicit quiescence and a matching-plan argument for legacy recovery", () => {
  // Given / When / Then: recovery cannot become a generic force-unlock command.
  expect(parseCliOptions("recover", [])).toEqual([]);
  expect(parseCliOptions("recover", ["--apply", "--quiesced", "--plan", "b".repeat(64)])).toEqual([]);
  for (const args of [["--apply"], ["--apply", "--plan", "p"], ["--quiesced"], ["--plan", "p"]]) {
    expect(() => parseCliOptions("recover", args)).toThrow("argument_invalid");
  }
});

it("rejects ambiguous cleanup authorization before opening any project", () => {
  // Given / When / Then: a missing plan, unused plan, or provider override is not valid cleanup.
  for (const args of [["--apply"], ["--plan", "p"], ["--api-url", "http://127.0.0.1"], ["--apply", "--apply"]]) {
    expect(() => parseCliOptions("prune", args)).toThrow("argument_invalid");
  }
});
