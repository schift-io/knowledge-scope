import { createHash } from "node:crypto";
import { canonicalJson } from "./json.js";
import {
  RetrievalEvaluationError, retrievalDatasetSchema, retrievalEvaluationSchema, retrievalReportSchema,
  type EvaluationQuestionReport, type RetrievalDataset, type RetrievalEvaluationReport,
} from "./evaluation/contracts.js";

export { RetrievalEvaluationError, retrievalDatasetSchema, retrievalCaptureSchema, retrievalReportSchema } from "./evaluation/contracts.js";
export type { RetrievalDataset, RetrievalCapture, RetrievalEvaluationReport } from "./evaluation/contracts.js";

const hash = (value: Parameters<typeof canonicalJson>[0]): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const byId = (left: { readonly questionId: string }, right: { readonly questionId: string }): number =>
  left.questionId < right.questionId ? -1 : left.questionId > right.questionId ? 1 : 0;
const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

function datasetFingerprint(dataset: RetrievalDataset): string {
  return hash({ ...dataset, questions: [...dataset.questions].sort(byId) });
}

/** Fingerprints the labels as well as snapshot and per-question input identities. */
export function fingerprintRetrievalDataset(value: unknown): string {
  return datasetFingerprint(retrievalDatasetSchema.parse(value));
}

function inputFingerprint(rows: readonly { readonly questionId: string; readonly inputFingerprint: string }[]): string {
  return hash([...rows].sort(byId).map((row) => ({ questionId: row.questionId, inputFingerprint: row.inputFingerprint })));
}

function metrics(rows: readonly EvaluationQuestionReport[]): RetrievalEvaluationReport["metrics"] {
  const total = (key: "expectedEvidenceCount" | "retrievedAtKCount" | "matchedAtKCount" | "citationMatchCount" | "forbiddenEvidenceCount") =>
    rows.reduce((sum, row) => sum + row[key], 0);
  return {
    // Micro recall: all expected evidence, including evidence beyond K, remains in the denominator.
    recallAtK: ratio(total("matchedAtKCount"), total("expectedEvidenceCount")),
    citationMatchRate: ratio(total("citationMatchCount"), total("retrievedAtKCount")),
    forbiddenEvidenceCount: total("forbiddenEvidenceCount"),
    decisionMatchRate: rows.filter((row) => row.expectedDecision === row.actualDecision).length / rows.length,
  };
}

/** Offline label matching only. Citation equality does not prove URL liveness or source truth. */
export function evaluateRetrieval(value: unknown): RetrievalEvaluationReport {
  const { dataset, capture, topK } = retrievalEvaluationSchema.parse(value);
  const fingerprint = datasetFingerprint(dataset);
  if (capture.datasetFingerprint !== fingerprint || capture.packDigest !== dataset.packDigest
    || capture.sourceSnapshotDigest !== dataset.sourceSnapshotDigest) {
    throw new RetrievalEvaluationError("snapshot_mismatch");
  }
  const results = new Map(capture.results.map((row) => [row.questionId, row]));
  if (results.size !== dataset.questions.length) throw new RetrievalEvaluationError("question_mismatch");
  const questions = [...dataset.questions].sort(byId).map((question): EvaluationQuestionReport => {
    const result = results.get(question.questionId);
    if (!result) throw new RetrievalEvaluationError("question_mismatch");
    if (result.inputFingerprint !== question.inputFingerprint) throw new RetrievalEvaluationError("input_mismatch");
    const expected = new Map(question.expectedEvidence.map((item) => [item.evidenceId, item.citation]));
    const returned = result.items.slice(0, topK);
    return {
      questionId: question.questionId, inputFingerprint: question.inputFingerprint,
      expectedEvidenceCount: expected.size, retrievedAtKCount: returned.length,
      matchedAtKCount: returned.filter((item) => expected.has(item.evidenceId)).length,
      citationMatchCount: returned.filter((item) => expected.get(item.evidenceId) === item.citation).length,
      // Count leaks throughout the captured result, not just the scored top K.
      forbiddenEvidenceCount: result.items.filter((item) => question.forbiddenEvidenceIds.includes(item.evidenceId)).length,
      expectedDecision: question.expectedDecision, actualDecision: result.decision,
    };
  });
  return {
    schemaVersion: "schift.retrieval-evaluation.v1",
    datasetId: dataset.datasetId, provenance: dataset.provenance, adapter: capture.adapter,
    datasetFingerprint: fingerprint, inputFingerprint: inputFingerprint(questions),
    packDigest: dataset.packDigest, sourceSnapshotDigest: dataset.sourceSnapshotDigest,
    topK, questions, metrics: metrics(questions),
  };
}

function parseReport(value: unknown): RetrievalEvaluationReport {
  const report = retrievalReportSchema.parse(value);
  if (inputFingerprint(report.questions) !== report.inputFingerprint
    || canonicalJson(metrics(report.questions)) !== canonicalJson(report.metrics)
    || report.questions.some((row) => row.retrievedAtKCount > report.topK)) {
    throw new RetrievalEvaluationError("report_invalid");
  }
  return report;
}

/** Right minus left; null means that metric has no labeled denominator. No winner is inferred. */
export function compareRetrievalReports(leftValue: unknown, rightValue: unknown) {
  const left = parseReport(leftValue);
  const right = parseReport(rightValue);
  const pin = (report: RetrievalEvaluationReport) => canonicalJson({
    datasetId: report.datasetId, provenance: report.provenance, datasetFingerprint: report.datasetFingerprint,
    inputFingerprint: report.inputFingerprint, packDigest: report.packDigest,
    sourceSnapshotDigest: report.sourceSnapshotDigest, topK: report.topK,
    labels: [...report.questions].sort(byId).map((row) => ({
      questionId: row.questionId, expectedDecision: row.expectedDecision, expectedEvidenceCount: row.expectedEvidenceCount,
    })),
  });
  if (pin(left) !== pin(right)) throw new RetrievalEvaluationError("comparison_mismatch");
  const difference = (before: number | null, after: number | null) =>
    before === null || after === null ? null : after - before;
  return {
    baselineAdapter: left.adapter, candidateAdapter: right.adapter,
    datasetFingerprint: left.datasetFingerprint, topK: left.topK,
    delta: {
      recallAtK: difference(left.metrics.recallAtK, right.metrics.recallAtK),
      citationMatchRate: difference(left.metrics.citationMatchRate, right.metrics.citationMatchRate),
      forbiddenEvidenceCount: right.metrics.forbiddenEvidenceCount - left.metrics.forbiddenEvidenceCount,
      decisionMatchRate: right.metrics.decisionMatchRate - left.metrics.decisionMatchRate,
    },
  };
}
