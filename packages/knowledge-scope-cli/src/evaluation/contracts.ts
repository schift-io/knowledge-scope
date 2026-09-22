import { z } from "zod";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const decision = z.enum(["ready", "insufficient_evidence"]);
const evidence = z.object({ evidenceId: id, citation: z.string().min(1).max(4096) }).strict();
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const evidenceList = z.array(evidence).max(100).refine(
  (rows) => unique(rows.map((row) => row.evidenceId)), "Duplicate evidence IDs",
);
const capturedEvidenceList = z.array(evidence.extend({ citation: z.string().max(4096).nullable() })).max(100).refine(
  (rows) => unique(rows.map((row) => row.evidenceId)), "Duplicate captured evidence IDs",
);
const question = z.object({
  questionId: id,
  inputFingerprint: digest,
  expectedDecision: decision,
  expectedEvidence: evidenceList,
  forbiddenEvidenceIds: z.array(id).max(100).refine(unique, "Duplicate forbidden evidence IDs"),
}).strict().refine(
  (row) => row.expectedEvidence.every((item) => !row.forbiddenEvidenceIds.includes(item.evidenceId)),
  "Expected and forbidden evidence overlap",
).refine((row) => row.expectedDecision !== "ready" || row.expectedEvidence.length > 0,
  "Ready questions need expected evidence");

export const retrievalDatasetSchema = z.object({
  datasetId: id,
  provenance: z.enum(["synthetic", "customer_provided"]),
  packDigest: digest,
  sourceSnapshotDigest: digest,
  questions: z.array(question).min(1).max(1000).refine(
    (rows) => unique(rows.map((row) => row.questionId)), "Duplicate question IDs",
  ),
}).strict();

export const retrievalCaptureSchema = z.object({
  adapter: id,
  datasetFingerprint: digest,
  packDigest: digest,
  sourceSnapshotDigest: digest,
  results: z.array(z.object({
    questionId: id, inputFingerprint: digest, decision, items: capturedEvidenceList,
  }).strict()).max(1000).refine(
    (rows) => unique(rows.map((row) => row.questionId)), "Duplicate captured question IDs",
  ),
}).strict();

export const retrievalEvaluationSchema = z.object({
  dataset: retrievalDatasetSchema,
  capture: retrievalCaptureSchema,
  topK: z.number().int().min(1).max(100),
}).strict();

const count = z.number().int().min(0).max(100000);
export const evaluationQuestionReportSchema = z.object({
  questionId: id, inputFingerprint: digest,
  expectedEvidenceCount: count, retrievedAtKCount: count, matchedAtKCount: count,
  citationMatchCount: count, forbiddenEvidenceCount: count,
  expectedDecision: decision, actualDecision: decision,
}).strict().refine((row) => row.matchedAtKCount <= Math.min(row.expectedEvidenceCount, row.retrievedAtKCount)
  && row.citationMatchCount <= row.matchedAtKCount, "Inconsistent evidence counts");
const rate = z.number().min(0).max(1).nullable();
export const retrievalReportSchema = z.object({
  schemaVersion: z.literal("schift.retrieval-evaluation.v1"),
  datasetId: id, provenance: z.enum(["synthetic", "customer_provided"]),
  adapter: id, datasetFingerprint: digest, inputFingerprint: digest,
  packDigest: digest, sourceSnapshotDigest: digest,
  topK: z.number().int().min(1).max(100),
  questions: z.array(evaluationQuestionReportSchema).min(1).max(1000).refine(
    (rows) => unique(rows.map((row) => row.questionId)), "Duplicate report question IDs",
  ),
  metrics: z.object({
    recallAtK: rate, citationMatchRate: rate,
    forbiddenEvidenceCount: count, decisionMatchRate: z.number().min(0).max(1),
  }).strict(),
}).strict();

export type RetrievalDataset = z.infer<typeof retrievalDatasetSchema>;
export type RetrievalCapture = z.infer<typeof retrievalCaptureSchema>;
export type RetrievalEvaluationReport = z.infer<typeof retrievalReportSchema>;
export type EvaluationQuestionReport = z.infer<typeof evaluationQuestionReportSchema>;

export class RetrievalEvaluationError extends Error {
  public override readonly name = "RetrievalEvaluationError";
  public constructor(public readonly code: "snapshot_mismatch" | "question_mismatch" | "input_mismatch" | "comparison_mismatch" | "report_invalid") {
    super(`Retrieval evaluation rejected: ${code}`);
  }
}
