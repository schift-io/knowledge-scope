# Run a support-context pilot

The pilot is for an AI application team, SI, or agency with approved support documents. Its first
task is to retrieve cited evidence for one support question and pass that evidence into its own
application. Start with the [local-file quickstart](../README.md#quickstart), which needs no account
or model. Install `@schift-io/knowledge-scope@0.2.0` for this path; the older `0.1.0` requires the
[hosted Search path](../README.md#hosted-search-advanced).

Success means the customer can repeat that retrieval, inspect its sources, and refuse an answer
when evidence is insufficient. Installing the package or passing synthetic tests does not establish
customer demand, live-provider compatibility, or better retrieval accuracy.

## Choose one question and one data boundary

Ask the customer for a repeated support question whose approved answer is present in the documents.
Record the expected document and passage before running retrieval. Obtain permission to copy those
documents into local private state. Start with a small UTF-8 Markdown/text source and a new project
directory. Do not publish source snapshots, generated local bindings, or installation state.

The initial path is:

```text
Approved Markdown/text documents
  -> quickstart --source and private local snapshot
  -> retrieve and admit cited evidence
  -> customer's application
  -> customer verifies the cited passage
```

Local retrieval is lexical and snapshot-based, not semantic search or continuous sync. Test both
source-word queries and real user phrasing; a passage match alone does not establish relevance.
Edit a source and confirm the old mount stays pinned; then create a new project/snapshot and
verify the changed passage. Filesystem access protects local state, not a multi-user ACL service.
An arbitrary local tenant label must not be presented as authentication or document authorization.

For an existing hosted corpus, select the authorized organization and bucket and confirm who may
read it. The Search adapter uses the mounted tenant and the Search API's organization/bucket ACL.
It rejects narrower `namespace`, `subject`, and `session` requests before HTTP because the provider
does not enforce those fields. An arbitrary tenant label is not a replacement for provider access
control. Use an appropriately scoped bucket and installation when separate data access is required.

Keep API tokens and customer source data outside the portable Pack. The Pack contains the declared
operation, schemas, and evidence rules; local bindings choose the authorized source.

## Extend to documents plus live records

After the document-only path works, select one read-only records operation, such as looking up
the status of an order. Use `runBatch` to retrieve the document and record operations under one
mounted policy and release their evidence only after combined admission succeeds.

1. Define the named operation and its input/result schemas. Identify its approved source and
   required evidence, including a stable record ID, revision, freshness, and citation.
2. Supply an authorized executor through the injected records port, or configure a read-only action
   in a separately operated Open Connector service. Its implementation is not included in this
   repository. The CLI does not create database connections or accept raw SQL.
3. For Open Connector, allowlist the exact connector, account alias, and read-only action. If the
   operation needs filters or narrower Scope, provide a trusted input mapper that applies those
   restrictions in the provider-native input. Without it, the adapter rejects the request.
4. Require one `document` and one `records` evidence item with separate `mustConsider` selectors
   and coverage assertion IDs. Bind each operation to its true source class. Verify that either
   operation alone returns insufficient evidence and no Candidates.
5. Send both operations in one `runBatch` request with the same installation, effective Scope,
   and expected revision. Verify both citations and required coverage. An invalid operation must
   fail before provider dispatch; a missing record, provider failure, or intervening unmount must
   not release partial evidence. Recheck admission after restarting the local process.
6. Give only admitted evidence to the customer's application. A missing required record or document
   must produce an insufficient-evidence outcome, not a guessed answer.

Use the examples as contract samples, not as proof that a customer's helpdesk or database has been
connected. Actual account authorization and provider behavior must be checked in the pilot.
Batch execution guarantees atomic admission/output, not a transaction or common snapshot across
providers. Record each source's own revision and freshness when evaluating consistency. Python
contract parity does not imply an independent Python provider-execution runtime.

## Measure a useful outcome

Before tuning retrieval, collect 30–50 customer questions with human-reviewed expected evidence.
Include unanswerable questions, stale documents, conflicting sources, and forbidden-source cases.
Keep a held-out subset out of prompt, Pack, and retrieval tuning.

For each capture, retain the question ID, dataset fingerprint, Pack digest, source snapshot,
retrieved evidence identity and citations, admission result, latency, and measured operating cost
when available. Avoid storing customer text in public examples or reports.

Compare Schift with the customer's current retrieval path on the same questions and frozen source
snapshot. Compare evidence identities that both paths can produce; adapter-specific SRNs alone
cannot define a fair cross-adapter ground truth. Record retrieval evidence separately from final
answer quality, which also depends on the customer's model and prompt.

An offline report is a measurement of the supplied captures. It does not establish live ACL
enforcement or a general accuracy advantage. Publish a comparison only with its sample size,
dataset scope, metric definitions, failure cases, and reproducible inputs.

The SDK's `evaluateRetrieval({ dataset, capture, topK })` evaluates captured results;
`compareRetrievalReports(baseline, candidate)` reports candidate-minus-baseline deltas. Both reports
must share dataset, input, Pack, source-snapshot fingerprints, and K. Missing, duplicate, or unknown
question IDs reject evaluation rather than silently reducing the sample.

| Metric | Definition |
| --- | --- |
| `recallAtK` | Total expected evidence IDs found in top K, divided by all expected evidence IDs across questions. |
| `citationMatchRate` | Top-K items matching both expected evidence ID and exact citation, divided by all returned top-K items. |
| `forbiddenEvidenceCount` | Forbidden evidence IDs across the entire capture, including items below K. |
| `decisionMatchRate` | Questions whose ready/insufficient decision matches the expected decision, divided by all questions. |

A zero evidence denominator yields `null`, not a perfect score. Citation matching checks labels;
it does not fetch URLs or prove that the cited source supports an answer. Synthetic examples only
demonstrate this evaluation contract.

## Recover without discarding the project

| Outcome | Next action |
| --- | --- |
| Configuration is missing | Supply the named environment variable, then retry. Never paste its value into a report. |
| Workspace already exists | Reuse the existing installation or choose a new directory; do not overwrite it. |
| Setup reports `artifactsComplete: false` | Inspect the preserved workspace and validate it before mounting; complete or correct the missing files first. |
| Search is unavailable | Preserve generated files and mount state, restore access, then use the reported recovery command. |
| Evidence is insufficient | Inspect the expected source, index contents, freshness, and evidence policy. Do not bypass admission to make the demo succeed. |
| Mount revision changed | Inspect the current installation and use its current revision. |
| Mount is inactive | Create a new authorized mount; unmount tombstones intentionally stay in state. |
| State is locked after a crash | Verify that the recorded process is gone before the owner removes the stale lock. Never delete an active writer's lock. |

A configuration check does not perform a retrieval. An explicit probe reads the configured
provider and may consume its normal usage. Keep the distinction in the acceptance record.

## CE and the managed offer

CE provides local authoring, validation, mounting, provider execution, admission, and SDK access.
The customer operates its local state and supplies authorized provider connections.

The managed offer to validate is operation of that same boundary: maintained connections,
indexing/synchronization, hosted persistence, access administration, regression monitoring,
private deployment, and support. These are proposed commercial scope until the corresponding
service is implemented and accepted; CE availability does not imply hosted availability.

Quote a pilot against an agreed source, question set, access boundary, acceptance test, and support
period. Do not invent a subscription price, seat fee, accuracy guarantee, or service-level promise
from this package's test results.

## External pilot gates

These are proposed go/no-go gates, not completed customer results. The pilot owner records dated
evidence and checks each box only after observing the outcome.

### Days 1–30: first independent use

- [ ] Three external teams install the artifact and retrieve their own cited evidence.
- [ ] Each team reaches its first useful result without an engineer editing the package for them.
- [ ] At least one customer supplies 30–50 reviewed questions and a baseline retrieval path.
- [ ] Record time to first useful result, failed setup steps, and whether the team uses it again.

If teams cannot activate, fix the most frequent setup failure before adding providers. If the
question set has no repeated customer task behind it, revise the pilot use case.

### Days 31–60: repeatable value

- [ ] Two teams use the integration repeatedly across at least two weeks.
- [ ] Run the frozen, held-out comparison and report regressions as well as improvements.
- [ ] Verify one real document-plus-records integration using the implemented combined
      retrieval/policy path under customer-approved access.
- [ ] Identify a buyer and confirm which operating responsibility they want Schift to take over.

If users do not return, investigate whether cited evidence changes their actual work. If Schift
adds integration effort without a measurable benefit, narrow the product or stop that use case.

### Days 61–90: paid continuation

- [ ] One customer accepts a paid continuation with written scope and acceptance criteria.
- [ ] Measure actual support effort and provider/infrastructure cost for that scope.
- [ ] A second installation repeats the first integration without customer-specific core forks.
- [ ] Decide whether to invest in the managed service using retention, payment, and support evidence.

No paid continuation after qualified pilots is a reason to revisit the offer and target customer,
not evidence that more infrastructure will create demand.

## Evidence status

Release-test observation (2026-09-22): the local Search HTTP fixture failed intermittently in
isolated full-suite runs. Earlier related-test and same-port replacement probes did not reproduce
the failure. During 0.2.0 release preparation, eight subsequent full-suite runs, including a
sanitized environment and isolated release copy, passed; installed Node.js lifecycle checks also
passed. The fixture now checks captured HTTP status and listener identity outside the adapter's
error-catching boundary, so a future failure cannot hide the fixture assertion behind a generic
provider error. The intermittent failure's cause remains unconfirmed. No production behavior,
timeout, or retry policy was changed to make these tests pass.

- [x] Local CE contract and adapter lifecycle have automated test coverage.
- [x] An installable tarball and local fake-provider E2E path exist.
- [x] Combined document/record retrieval has local contract and installed-artifact checks.
- [ ] Live customer account certification.
- [ ] Customer-owned held-out retrieval benchmark.
- [ ] Proven retrieval advantage over the customer's existing approach.
- [ ] Three external activations and repeat usage.
- [ ] Paid continuation and measured operating margin.

Implementation status lives in `packages/context-pack/AUTO_SCOPE.md` in the source repository.
Customer validation remains separate from implementation checkmarks.
