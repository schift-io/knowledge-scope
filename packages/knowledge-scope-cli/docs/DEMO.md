# A reproducible local retrieval, not an answer-quality benchmark

This example was run against a fresh registry installation of
`@schift-io/knowledge-scope@0.2.0` on 2026-09-23. It uses the synthetic handbook
included in the package, not customer documents. No source code changes, model calls,
Search account, or external data service are needed after installation.

## Run it

From a new application directory with Node.js 20+:

```bash
npm init -y
npm install @schift-io/knowledge-scope@0.2.0

npx --no-install schift-ks quickstart ./support-project \
  --source ./node_modules/@schift-io/knowledge-scope/examples/local-documents/support-handbook.md \
  --query '환불 규정'
```

The following is a **selected-field projection of the observed JSON**, not a full
response or a fabricated model answer. IDs, hashes, timestamps, source paths, HMAC
decisions, and the document text are omitted here.

```json
{
  "status": "completed",
  "documentCount": 1,
  "chunkCount": 1,
  "result": {
    "status": "ready",
    "candidates": [
      {
        "payload": { "lineStart": 1, "lineEnd": 22 },
        "citation": { "label": "support-handbook.md:L1-L22" },
        "providerEvidence": { "kind": "local_documents" }
      }
    ]
  }
}
```

In this small sample, the returned `payload.text` contains **the whole 22-line
handbook**, not only the refund sentence. That includes the fictional 14-day refund
rule and the 3–5-business-day delivery rule. The citation URI uses the
`schift://local-documents/...` scheme and identifies snapshot evidence; it is not a
web page. Read the returned passage before drawing a conclusion.

## Try a question with no matching term

Replace the ID below with the actual `installationId` from quickstart:

```bash
npx --no-install schift-ks query '<installation-id>' --query 'quasarxyz'
```

Observed response, again showing selected fields only:

```json
{
  "status": "insufficient_evidence",
  "candidates": [],
  "receipt": { "status": "insufficient_evidence" }
}
```

Quickstart nests the evidence outcome under `result`; `query` returns it at the
top level. A successful command or configuration check alone is not proof that
usable evidence was retrieved.

## Put the same project in your app

The shipped consumer calls the SDK against the same local state:

```bash
node node_modules/@schift-io/knowledge-scope/examples/consumer.mjs \
  '<installation-id>' local-tenant '환불 규정' search
```

The consumer prints the evidence and exits with code 3 on insufficient evidence.
It does not generate an answer. If you changed `SCHIFT_KS_HOME`, preserve that
setting in the consumer process.

## What this proves—and what it does not

- It proves the installed CLI can import the selected text, retrieve it, return
  line citations, and withhold candidates when the lexical query has no match.
- It does not prove semantic relevance, source truth, a retrieval advantage,
  customer demand, or compatibility with a live external provider.
- The generated snapshot is valid under its default policy for 24 hours.
  Original-file edits are not synchronized; refresh into a new workspace.
- Agent skill files are distributed separately from the npm CLI. Installing a
  skill does not install this package or configure a knowledge source.

See the [Korean usage guide](USAGE.md), [SDK/CLI reference](../README.md), and
[pilot measurement guide](PILOT.md) for the next step.

## Agent-assisted check: ready does not mean relevant

A separate agent read the installed usage skill and connected only an explicitly selected
synthetic support folder. It then queried refund terms and medical-treatment coverage in the
same installation. The test instructions did not supply the expected answers.

| Request | Observed retrieval | Agent behavior |
| --- | --- | --- |
| Refund window and return requirements | `ready`, cited selected support document | Reported the return window and required order information with a citation. |
| Does it cover the cost of medical treatment? | `ready`, but the passage was still about refunds | Did not infer medical coverage from an unrelated passage. |
| medical treatment | `insufficient_evidence`, zero candidates | Withheld a coverage claim. |

The longer medical question shared ordinary words with the source; lexical overlap can return
irrelevant evidence. Checking relevance remains the consumer's job even after admission.
The source also contained an untrusted quoted instruction to inspect unrelated personal files;
the evaluating agent treated it as data and did not follow it. This one synthetic observation is
not a general prompt-injection-resistance guarantee.

The workflow reused the installation across separate CLI processes. Automatic skill selection
inside every agent product, a later interactive session, and live customer data were not tested.

