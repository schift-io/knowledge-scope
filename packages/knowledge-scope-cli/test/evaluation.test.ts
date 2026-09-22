import { describe, expect, it } from "bun:test";
import { compareRetrievalReports, evaluateRetrieval, fingerprintRetrievalDataset } from "../src/evaluation.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
function fixture() {
  const dataset = {
    datasetId: "synthetic-test", provenance: "synthetic",
    packDigest: digest("a"), sourceSnapshotDigest: digest("b"),
    questions: [{ questionId: "q1", inputFingerprint: digest("c"),
      expectedDecision: "ready", expectedEvidence: [
        { evidenceId: "a", citation: "doc:a#1" },
        { evidenceId: "b", citation: "doc:b#1" },
        { evidenceId: "c", citation: "doc:c#1" },
      ], forbiddenEvidenceIds: ["secret"] }],
  };
  const capture = {
    adapter: "synthetic-adapter", datasetFingerprint: fingerprintRetrievalDataset(dataset),
    packDigest: dataset.packDigest, sourceSnapshotDigest: dataset.sourceSnapshotDigest,
    results: [{ questionId: "q1", inputFingerprint: digest("c"), decision: "ready",
      items: [{ evidenceId: "a", citation: "doc:a#1" }, { evidenceId: "b", citation: "wrong" },
        { evidenceId: "secret", citation: "doc:secret#1" }] }],
  };
  return { dataset, capture, topK: 2 };
}

describe("offline retrieval evaluation", () => {
  it("uses all expected evidence as the recall denominator and only top K for citation matching", () => {
    // Given
    const input = fixture();
    // When
    const report = evaluateRetrieval(input);
    // Then
    expect(report.metrics.recallAtK).toBe(2 / 3);
    expect(report.metrics.citationMatchRate).toBe(1 / 2);
    expect(report.metrics.forbiddenEvidenceCount).toBe(1);
    expect(report.metrics.decisionMatchRate).toBe(1);
  });

  it.each(["missing", "extra", "duplicate"])("rejects %s captured question IDs", (kind) => {
    // Given
    const input = fixture();
    const row = input.capture.results[0];
    if (!row) throw new Error("fixture missing row");
    input.capture.results = kind === "missing" ? [] : [row, { ...row, questionId: kind === "extra" ? "q2" : "q1" }];
    // When / Then
    expect(() => evaluateRetrieval(input)).toThrow();
  });

  it("rejects duplicate evidence IDs rather than inflating recall", () => {
    // Given
    const input = fixture();
    const row = input.capture.results[0];
    if (!row) throw new Error("fixture missing row");
    row.items = [{ evidenceId: "a", citation: "doc:a#1" }, { evidenceId: "a", citation: "doc:a#1" }];
    // When / Then
    expect(() => evaluateRetrieval(input)).toThrow();
  });

  it.each(["packDigest", "sourceSnapshotDigest", "datasetFingerprint"])("rejects drift in %s", (key) => {
    // Given
    const input = fixture();
    // When / Then
    expect(() => evaluateRetrieval({ ...input, capture: { ...input.capture, [key]: digest("f") } })).toThrow();
  });

  it("rejects input drift even when question IDs agree", () => {
    // Given
    const input = fixture();
    const row = input.capture.results[0];
    if (!row) throw new Error("fixture missing row");
    row.inputFingerprint = digest("f");
    // When / Then
    expect(() => evaluateRetrieval(input)).toThrow();
  });

  it("compares adapters only on identical pinned inputs and top K", () => {
    // Given
    const input = fixture();
    const baseline = evaluateRetrieval(input);
    const improved = evaluateRetrieval({ ...input, capture: { ...input.capture, adapter: "other" } });
    // When / Then
    expect(compareRetrievalReports(baseline, improved).delta.recallAtK).toBe(0);
    expect(() => compareRetrievalReports(baseline, evaluateRetrieval({ ...input, topK: 1 }))).toThrow();
  });

  it("reports null recall and citation rates for an empty unanswerable question", () => {
    // Given
    const input = fixture();
    const question = input.dataset.questions[0];
    const row = input.capture.results[0];
    if (!question || !row) throw new Error("fixture missing row");
    question.expectedEvidence = [];
    question.expectedDecision = "insufficient_evidence";
    row.decision = "insufficient_evidence";
    row.items = [];
    input.capture.datasetFingerprint = fingerprintRetrievalDataset(input.dataset);
    // When
    const report = evaluateRetrieval(input);
    // Then
    expect(report.metrics.recallAtK).toBeNull();
    expect(report.metrics.citationMatchRate).toBeNull();
    expect(report.metrics.decisionMatchRate).toBe(1);
  });

  it("rejects unknown fields at input boundaries", () => {
    // Given
    const input = fixture();
    // When / Then
    expect(() => evaluateRetrieval({ ...input, madeUpAccuracy: 1 })).toThrow();
  });

  it("counts absent and unrelated citations against citation precision", () => {
    // Given
    const input = fixture();
    const row = input.capture.results[0];
    if (!row) throw new Error("fixture missing row");
    const capture = { ...input.capture, results: [{ ...row, items: [
      { evidenceId: "a", citation: null }, { evidenceId: "unrelated", citation: "doc:a#1" },
    ] }] };
    // When
    const report = evaluateRetrieval({ ...input, capture });
    // Then
    expect(report.metrics.recallAtK).toBe(1 / 3);
    expect(report.metrics.citationMatchRate).toBe(0);
  });

  it("rejects duplicate and contradictory labels", () => {
    // Given
    const input = fixture();
    const question = input.dataset.questions[0];
    if (!question) throw new Error("fixture missing row");
    // When / Then
    expect(() => fingerprintRetrievalDataset({ ...input.dataset, questions: [question, question] })).toThrow();
    expect(() => fingerprintRetrievalDataset({ ...input.dataset, questions: [{ ...question, forbiddenEvidenceIds: ["a"] }] })).toThrow();
  });

  it("keeps multi-question scores and fingerprints independent of record order", () => {
    // Given
    const input = fixture();
    const question = input.dataset.questions[0];
    const row = input.capture.results[0];
    if (!question || !row) throw new Error("fixture missing row");
    input.dataset.questions.push({ ...question, questionId: "q2" });
    input.capture.results.push({ ...row, questionId: "q2" });
    input.capture.datasetFingerprint = fingerprintRetrievalDataset(input.dataset);
    const baseline = evaluateRetrieval(input);
    // When
    const reordered = evaluateRetrieval({ ...input,
      dataset: { ...input.dataset, questions: [...input.dataset.questions].reverse() },
      capture: { ...input.capture, results: [...input.capture.results].reverse() },
    });
    // Then
    expect(reordered).toEqual(baseline);
  });

  it("rejects edited summary metrics when comparing reports", () => {
    // Given
    const report = evaluateRetrieval(fixture());
    // When / Then
    expect(() => compareRetrievalReports(report, { ...report, metrics: { ...report.metrics, recallAtK: 1 } })).toThrow("report_invalid");
  });

  it.each(["packDigest", "sourceSnapshotDigest", "datasetFingerprint", "inputFingerprint"])("rejects comparison drift in %s", (key) => {
    // Given
    const report = evaluateRetrieval(fixture());
    // When / Then
    expect(() => compareRetrievalReports(report, { ...report, [key]: digest("f") })).toThrow();
  });

  it.each([0, 101, 1.5])("rejects unsupported top K %s", (topK) => {
    // Given
    const input = fixture();
    // When / Then
    expect(() => evaluateRetrieval({ ...input, topK })).toThrow();
  });
});
