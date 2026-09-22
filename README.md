# Schift Knowledge Scope

Retrieve cited evidence for your AI application within a project's declared access boundary.
Knowledge Scope connects declared operations to existing data providers, validates their evidence,
and returns it to the model or application you choose.

```bash
npm install @schift-io/knowledge-scope@0.1.0
npx --no-install schift-ks --help
```

Start with the [quickstart](packages/knowledge-scope-cli/README.md#quickstart). It requires Node.js
20 or later and an existing, authorized Schift Search index. The package does not upload, parse,
or index documents, and it does not generate the final answer.

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

The TypeScript SDK and Node.js CLI include Schift Search and Open Connector adapters plus an
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

The published npm release is [`@schift-io/knowledge-scope@0.1.0`](https://www.npmjs.com/package/@schift-io/knowledge-scope/v/0.1.0).
Its archive SHA-256 is:

```text
e2530b680a78efc36c519f6f13828442a79a68f24c959220903b0c8cda6089ea
```

This public repository starts from the release implementation at source commit `2c6276f5e`.
Its workspace packaging and documentation were adapted for a standalone checkout. A GitHub source
archive is therefore not byte-identical to the published npm archive. Use the npm artifact and
checksum above when reproducing the published binary package.

## License

See [LICENSE](LICENSE).
