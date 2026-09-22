# Contributing

Start with the [SDK and CLI guide](packages/knowledge-scope-cli/README.md) and
[implementation status](packages/context-pack/AUTO_SCOPE.md). Keep changes focused on portable
Knowledge Scope contracts, evidence retrieval, admission, and developer integration.

## Local checks

Use Node.js 20+, npm, and Bun. From the repository root:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify
```

For Python contract changes, use Python 3.12+ and uv:

```bash
uv run --project packages/core/context-pack/python --extra dev pytest packages/core/context-pack/python/tests
uv build --project packages/core/context-pack/python --wheel
```

Keep shared fixtures consistent across TypeScript and Python when changing canonical JSON,
digests, request contracts, or admission behavior. Python provides contract and admission parity;
provider execution belongs to the Node.js runtime.

## Changes and reports

- Add a focused regression test when fixing a behavioral defect. Include failure and denied-access
  cases when changing a trust boundary.
- Update the relevant guide when a command, required configuration, or public contract changes.
- State which checks passed and which could not run. Distinguish local fixture results from live
  provider verification.
- Keep tokens, customer documents, account identifiers, local state, and private logs out of
  commits and issue reports. Use synthetic fixtures for reproducible cases.
- Explain the user-visible problem, expected behavior, and smallest reproduction in an issue or
  pull request. Include runtime versions and a redacted error code where relevant.

Running the checks does not publish a release. Maintainers handle npm publication separately.
