# Schift Knowledge Scope

Retrieve cited passages from your Markdown or text files, then pass admitted evidence to your AI
application. Start locally without a Schift account, cloud service, or model credentials. Your
application chooses the model and generates the answer.

```bash
npm install @schift-io/knowledge-scope@0.2.0
npx --no-install schift-ks quickstart ./support-project \
  --source ./node_modules/@schift-io/knowledge-scope/examples/local-documents/support-handbook.md \
  --query '환불 규정'
```

Requires Node.js 20 or later and a new destination directory. Expect `result.status: "ready"`
with a passage about the synthetic handbook's 14-day refund window and its source line range.
Keep the returned `installationId` to ask again:

```bash
npx --no-install schift-ks query '<installation-id>' --query '배송 기간'
node node_modules/@schift-io/knowledge-scope/examples/consumer.mjs \
  '<installation-id>' local-tenant '환불 규정' search
```

Next, replace `--source` with your own UTF-8 `.md` or `.txt` file or folder and choose a new project
directory. The [quickstart](packages/knowledge-scope-cli/README.md#quickstart) explains snapshot
refresh, privacy, limits, and recovery. Search is lexical, not semantic: a matching passage is not
proof of a correct answer. Source text stays in private local state outside the portable Pack.
There is no automatic sync, PDF/URL ingestion, or bundled MCP adapter.

## Guides

- [SDK and CLI guide](packages/knowledge-scope-cli/README.md): setup, mounting, retrieval, admission,
  provider configuration, and recovery.
- [Application example](packages/knowledge-scope-cli/examples/consumer.mjs): consume admitted evidence.
- [Combined retrieval example](packages/knowledge-scope-cli/examples/batch-consumer.mjs): run several
  declared operations under one mount and admit their results together.
- [Evaluation example](packages/knowledge-scope-cli/examples/evaluation/README.md): compare captured
  retrieval results against the same reviewed evidence set.
- [Pilot guide](packages/knowledge-scope-cli/docs/PILOT.md): apply the package to a customer's data
  and measure useful outcomes.
- [Implementation status](packages/context-pack/AUTO_SCOPE.md): completed features and open validation.

## What you can build

A support application can retrieve a shipping-policy document and an order record in one
`runBatch` request. The mount chooses the authorized providers. The portable definition declares
the operations, schemas, access constraints, and required evidence. The application receives
Candidates only after every requested operation contributes evidence and combined admission passes.

This provides atomic admission and output, not a shared database transaction or synchronized
snapshot across providers. Each evidence item retains its own citation, revision, and freshness.
See [the batch request and CLI example](packages/knowledge-scope-cli/README.md#manual-authoring)
and [the document-plus-records pilot](packages/knowledge-scope-cli/docs/PILOT.md#extend-to-documents-plus-live-records).

The TypeScript SDK and Node.js CLI include local-document, Schift Search, and Open Connector adapters plus an
injected named-records execution port. Open Connector is a separately operated runtime; its
implementation is not included in this repository. A configured endpoint and authorized account
are required to use that adapter.

The [Python package](packages/core/context-pack/python) mirrors the portable contracts, canonical
digests, and pure admission checks. It is not a Python provider-execution runtime or CLI.

## Develop and verify

Install Node.js 20+, npm, and Bun, then run from the repository root:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify
```

`verify` exercises the release packaging and installed-consumer path. It does not publish to npm
or deploy a service. Provider tests use local synthetic HTTP fixtures; passing them does not
certify a live customer's account, access policy, or retrieval quality.

For Python, install Python 3.12+ and uv:

```bash
uv run --project packages/core/context-pack/python --extra dev pytest packages/core/context-pack/python/tests
uv build --project packages/core/context-pack/python --wheel
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for change and verification expectations.

## Release source mapping

This checkout targets [`@schift-io/knowledge-scope@0.2.0`](https://www.npmjs.com/package/@schift-io/knowledge-scope/v/0.2.0)
and incorporates the release implementation from source snapshot `318c81726`.
Its workspace packaging and documentation were adapted for a standalone checkout. A GitHub source
archive is therefore not byte-identical to the npm archive. Use the package archive and
`SHA256SUMS` attached to the matching [GitHub release](https://github.com/schift-io/knowledge-scope/releases)
when reproducing a published binary package.

## License

See [LICENSE](LICENSE).
