# Offline evidence evaluation

From the built package directory run `node examples/evaluation/run.mjs`.
This example is entirely synthetic, makes no network/model calls, and demonstrates scoring only.
Its hand-authored better result does not demonstrate a Schift accuracy advantage.

`evaluateRetrieval({ dataset, capture, topK })` requires exactly one captured result per unique
question ID, the dataset fingerprint from `fingerprintRetrievalDataset(dataset)`, the same Pack
digest and source snapshot digest, and identical per-question input fingerprints. Set the input
fingerprint to a SHA-256 of the complete request (query, filters and authority context), using the
same canonicalization in both adapters. Pin the dataset and inputs before collecting results.
The evaluator checks declared identities, not whether an external provider actually used them.

Map both adapters' result IDs to the same dataset `evidenceId`; adapter-specific Candidate SRNs
are not comparable evidence IDs. Each expected ID maps to its expected citation string.
Captured citations may be `null` for missing citations. A citation match means exact string and
evidence-ID agreement; it does not check URL liveness, document validity, or answer correctness.

- `recallAtK`: sum of unique expected IDs found in each top-K result / all expected IDs.
  The denominator is not capped at K. Questions with no expected evidence contribute zero to both
  counts; when the entire dataset has no expected evidence the metric is `null`.
- `citationMatchRate`: expected ID + citation matches in top K / all returned top-K items.
  Missing/wrong citations and unexpected IDs count against this rate. No returned items means `null`.
- `forbiddenEvidenceCount`: all returned forbidden IDs, including those beyond K.
- `decisionMatchRate`: matching `ready`/`insufficient_evidence` decisions / all questions.

Duplicate result/label IDs, missing or extra questions, unknown fields, and fingerprint drift
are rejected. The bounded format accepts at most 1,000 questions, 100 evidence items per question,
and K from 1 to 100. `compareRetrievalReports(left, right)` requires matching snapshots, labels,
inputs and K. It reports right-minus-left deltas, without selecting a winner or hiding regressions.

For customer evaluation use `provenance: "customer_provided"`, held-out questions and manually
reviewed evidence/citation labels. This flag describes provenance supplied by the caller; it is
not proof of independent review. Reports are unsigned local measurement artifacts.
