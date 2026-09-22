# Schift Knowledge Scope CE

Connect an existing Schift Search index to your AI application and return cited evidence within
one project's declared access boundary. Your application chooses the model and generates the answer.

Start with the [first retrieval](#quickstart), then use the SDK in your application. For a customer
trial, follow the [pilot guide](docs/PILOT.md), which separates local verification from live-customer
acceptance.

```text
scope.json + schema files
          │ validate + lock
          ▼
portable KnowledgeScopeDefinition
          │ mount
          ▼
server-owned KnowledgeScopeMount
          │ declared operation only
          ▼
Open Connector / Schift Search / injected records port
          │ normalize + authorize + admit
          ▼
CandidateEnvelope[] + admission receipt
```

## What is implemented

- [x] Portable Definition and server-owned Mount are separate contracts.
- [x] The lock covers canonical `scope.json` plus every referenced input/result schema.
- [x] Local mount state uses owner-only, atomic file persistence and optimistic revisions.
- [x] Authorization decisions HMAC-bind the complete immutable Candidate evidence projection and
      survive process restarts.
- [x] Open Connector executes declared actions through its public runtime API.
- [x] Schift Search uses the authenticated v2 status + retrieve APIs.
- [x] Direct named-record execution is available through an injected application port.
- [x] Candidate admission checks source, operation, provider, permission mode, Scope, citation,
      freshness, connector audit correlation, and required provider scopes.
- [x] Aggregate admission enforces every declared `minEvidence` coverage assertion.
- [x] `run-batch` combines up to eight declared operations under one mount and admits their evidence together.
- [x] CLI and loopback HTTP API use the same application and persistent state.
- [x] Public npm package `@schift-io/knowledge-scope@0.1.0`, tagged `latest`.
- [ ] Schift Cloud multi-tenant persistence, production deployment, and live
      provider-account certification. Those are separate operational actions.

OBS, Context Runtime/A2A, APM, Agent execution, Workflow execution, and final LLM generation are
deliberately outside this package.

## Quickstart

You need Node.js 20 or later and an **already indexed** Schift Search corpus.
Obtain the Search endpoint, authorized token, organization ID, and index name from its owner.
This package does not upload, parse, or index your documents. A new empty index will not produce
usable evidence.

Install the published package in your application directory:

```bash
npm install @schift-io/knowledge-scope@0.1.0
npx --no-install schift-ks --help
```

Keep credentials in your local runtime environment. The values below are placeholders, not demo
credentials:

```bash
export SCHIFT_KS_SEARCH_URL=https://api.schift.io
export SCHIFT_KS_SEARCH_TOKEN='<authorized Search token>'
export SCHIFT_KS_SEARCH_ORGANIZATION_ID='<your organization ID>'
export SCHIFT_KS_SEARCH_SCOPES=search:read
```

Create a new workspace and retrieve evidence. Replace `support-handbook` and `tenant.acme` with
the authorized index and project tenant. The destination must not already exist:

```bash
npx --no-install schift-ks quickstart ./support-project \
  --index support-handbook --tenant tenant.acme \
  --query 'How do I reset a subscription?'
```

The command creates portable files in `support-project/pack/`, with local `bindings.json`,
`input.json`, and `installation.json` beside that directory. It locks, mounts, and runs the `search`
operation. Save the returned `installationId`. `result.status: "ready"` means admitted evidence is
available; `"insufficient_evidence"` means the application must not answer from these results.
The outer `status: "completed"` reports completion of the command, not evidence sufficiency.

Check the installation without a provider request, or explicitly probe it with another question:

```bash
npx --no-install schift-ks doctor '<installation-id>'
npx --no-install schift-ks doctor '<installation-id>' --probe --query 'How do I reset a subscription?'
```

The default doctor report has `evidenceVerified: false`; `configured` does not certify live
retrieval. A probe executes the normal read path and may consume provider usage. On a run failure,
quickstart preserves the workspace and reports a recovery command rather than overwriting it.
If filesystem setup failed, `artifactsComplete: false` means the workspace needs inspection and
validation before mounting; the recovery command does not claim that incomplete files are ready.

## Use the evidence in your application

The installed package includes a consumer that uses the same local state and provider environment:

```bash
node node_modules/@schift-io/knowledge-scope/examples/consumer.mjs \
  '<installation-id>' tenant.acme 'How do I reset a subscription?' search
```

It prints the typed result, exits with code 3 for insufficient evidence, and never calls a model.
In your application, `createKnowledgeScopeClient({ application })` exposes `inspect(installationId)`,
`run(request)`, `runBatch(request)`, and `admit(request)`. Inject `createCliDependencies().embedded` for the local
application or a `createRemoteKnowledgeScopeApplication` instance for the authenticated HTTP API.
The client validates response contracts and identity; the application remains responsible for
authorization and HMAC verification.

Only pass `result.candidates` to downstream processing when `result.status === "ready"`. Preserve
each candidate's citation when assembling context. Your model, prompt, and answer UI remain yours.

For offline retrieval measurements, see the [evaluation example](examples/evaluation/README.md)
and the [pilot metric definitions](docs/PILOT.md#measure-a-useful-outcome). The included dataset is
synthetic and makes no accuracy claim about a live provider.

## Manual authoring

For a complete editable definition, copy the shipped support example into a new directory from
your application root. This example declares `search-handbook`, `fetch-support`, and `list-orders`;
the matching bindings name those exact operations:

```bash
mkdir ./manual-support
cp -R node_modules/@schift-io/knowledge-scope/examples/support-scope ./manual-support/pack
cp node_modules/@schift-io/knowledge-scope/examples/mount-bindings.json ./manual-support/bindings.json
```

In `manual-support/bindings.json`, replace `replace-with-organization` with the same organization
as `SCHIFT_KS_SEARCH_ORGANIZATION_ID`, and replace `replace-with-tenant` with your tenant. The sample
Search index is `support-handbook`; if yours differs, change both the capability's `indexRef` in
`pack/scope.json` and its Search binding's `providerRef` in `bindings.json` to your index name.
These files contain references, never credentials.

```bash
npx --no-install schift-ks validate ./manual-support/pack
npx --no-install schift-ks lock ./manual-support/pack
npx --no-install schift-ks mount ./manual-support/pack --bindings ./manual-support/bindings.json
npx --no-install schift-ks inspect '<installation-id>'
```

Use the returned installation ID in subsequent commands. Mounting records and connector bindings
does not configure their executors; running those two operations requires the separate provider
configuration described below. The Search operation can run independently.

When a definition declares capabilities, every supplied binding must name at least one coherent
operation and at least one declared capability must be bound. Other provider-specific capabilities
may remain unbound and fail with `operation_not_bound` if called. A zero-capability, document-only
definition may still mount with an empty operation list.

Save this strict JSON document as `manual-support/run.json`. Replace `replace-with-tenant` with
the **same value** used in `bindings.json`; this is not an additional access boundary:

```json
{
  "effectiveScope": {"tenant": "replace-with-tenant"},
  "input": {"query": "How do I reset a subscription?"},
  "filters": {},
  "expectedRevision": 1
}
```

```bash
npx --no-install schift-ks run '<installation-id>' search-handbook --input ./manual-support/run.json
```

To stop using the mount, inspect its current revision and pass that revision to
`schift-ks unmount '<installation-id>' --expected-revision <revision>`.

`schift-ks init <new-directory>` is a separate authoring tool: it creates an empty skeleton with
no capabilities. Before attaching an operation binding, declare that operation and its referenced
schemas yourself. Do not attach the shipped example's operation bindings to the empty skeleton.

`admit` accepts either one Candidate object or a nonempty JSON array. Use an array to evaluate
already available Candidates as one aggregate coverage set:

```bash
npx --no-install schift-ks admit '<installation-id>' --candidate ./candidates.json
```

Each `run` executes one operation against the full Scope policy and withholds all Candidates when
coverage is insufficient. To retrieve documents and records together, declare separate required
coverage rules for `document` and `records`, then call `run-batch` with both operations:

```json
{
  "effectiveScope": {"tenant": "replace-with-tenant"},
  "expectedRevision": 1,
  "operations": [
    {"operationId": "search-handbook", "input": {"query": "What is the shipping policy?"}},
    {"operationId": "fetch-support", "input": {"query": "Order 123 status"}}
  ]
}
```

Save this as `batch.json`, with inputs matching your declared schemas and a current mount revision:

```bash
npx --no-install schift-ks run-batch '<installation-id>' --input ./batch.json
node node_modules/@schift-io/knowledge-scope/examples/batch-consumer.mjs '<installation-id>' ./batch.json
```

The shipped support Pack is a schema example; it does not already require both classes. For a
combined policy, add two `mustConsider` rules and list both IDs in `evidence.coverageAssertions`.
Bind the actual record operation as `sourceClass: "records"`; the sample helpdesk binding is
`activity_stream` and must not be relabeled unless its source really supplies records.

Batch requests contain 1–8 unique operation IDs. All inputs and bindings are validated before
provider dispatch; execution is sequential, with a combined ceiling of 100 Candidates and 8 MiB.
Admission rechecks the current mount before releasing the combined evidence. A failed operation or
unsatisfied policy releases no partial Candidate payload. Separate insufficient runs cannot be
accumulated through `admit`, because those runs withhold their Candidates.
Every requested operation must contribute evidence. Even if the remaining operations satisfy
coverage, an empty operation fails with `batch_incomplete`; rejected Candidates fail with
`candidate_invalid`. Neither error includes partial evidence.

This is atomic admission and output, not a shared transaction or synchronized snapshot across
external providers. Each source retains its own revision and freshness. Python provides matching
request contracts and pure admission checks; this package's execution runtime and CLI are Node.js.
See the [combined pilot path](docs/PILOT.md#extend-to-documents-plus-live-records).

All successful output is JSON on stdout. Errors are redacted JSON on stderr with a stable `code`
and a non-zero exit status.

## Provider configuration

Provider URLs and credentials are runtime configuration. They are never written to `scope.json`,
the lock, mount state, Candidate output, or errors.

Open Connector is a separately operated service that owns account connections, credentials, and
its public action runtime. Its implementation is not included in this repository. Configure an
authorized endpoint:

```bash
export SCHIFT_KS_OPEN_CONNECTOR_URL=http://127.0.0.1:3000
export SCHIFT_KS_OPEN_CONNECTOR_TOKEN=...
export SCHIFT_KS_OPEN_CONNECTOR_SCOPES=tickets:read
export SCHIFT_KS_OPEN_CONNECTOR_ALIAS=work
export SCHIFT_KS_OPEN_CONNECTOR_READ_ACTIONS='[{"connectorRef":"zendesk","connectorAlias":"work","actionId":"zendesk.search_tickets"}]'
```

`SCHIFT_KS_OPEN_CONNECTOR_READ_ACTIONS` is a strict server-owned JSON allowlist of connector,
account alias, and action triples. A Pack cannot authorize its own action or select a different
account with the same action ID; any triple not explicitly attested as retrieval-only is rejected
before HTTP.
The generic Open Connector adapter never drops an allowed filter or narrower Scope silently.
Nonempty filters and `namespace` / `subject` / `session` Scope require an injected trusted input
mapper in the SDK; without one, execution fails before HTTP. The mapper receives trusted Scope and
must bind it into the provider-native, schema-validated action input. Tenant-only calls may use the
mounted connector/account boundary directly.

Schift Search:

```bash
export SCHIFT_KS_SEARCH_URL=https://api.schift.io
export SCHIFT_KS_SEARCH_TOKEN=...
export SCHIFT_KS_SEARCH_ORGANIZATION_ID=org.acme
export SCHIFT_KS_SEARCH_SCOPES=search:read
```

The Schift Search adapter first reads `/v2/buckets/{index}/search/status`, then retrieves passages
from `/v2/buckets/{index}/retrieve`. Missing source identity, revision, citation, or freshness fails
closed. The credential-bound organization ID must match the mounted organization and is sent as
`X-Org-Id`, so the Search API's normal organization/bucket ACL remains authoritative. The local
tenant/effective Scope is an additional Schift KS constraint; it is not presented as a provider
tenant attestation. The adapter never falls back to another index or to Web search.
The current v2 Search API does not enforce `namespace`, `subject`, or `session` narrowing, so this
adapter rejects those requests before HTTP. Use an appropriately scoped bucket and installation
for separate access boundaries; adding an arbitrary Scope field does not filter provider data.

For `records_operation`, library consumers inject the named-operation executor through the public
provider port. The default CLI does not invent SQL, accept raw predicates, or hold database
credentials; an unconfigured records operation returns `invalid_configuration`. Open Connector may
also be used as the managed database gateway.

`web_search` remains a portable provider declaration for compatible runtimes, but the local CE
control plane does not silently choose or bill a Web provider in v0.1. It fails closed with
`invalid_configuration`; applications can use Schift Search, Open Connector, or an injected records
port until a separately governed Web-search adapter is installed.

## Local HTTP API

Start the same application as a loopback service:

```bash
export SCHIFT_KS_ORGANIZATION_ID=org.acme
export SCHIFT_KS_TENANT=tenant.acme
export SCHIFT_KS_API_TOKEN='<random owner-only token>'
node dist/main.js serve --host 127.0.0.1 --port 8787
```

Routes:

- `POST /v1/knowledge-scopes/mounts`
- `GET /v1/knowledge-scopes/mounts/{installationId}`
- `POST /v1/knowledge-scopes/mounts/{installationId}/unmount`
- `POST /v1/knowledge-scopes/mounts/{installationId}/capabilities/{operationId}:run`
- `POST /v1/knowledge-scopes/mounts/{installationId}:run-batch`
- `POST /v1/knowledge-scopes/mounts/{installationId}:admit`

The HTTP mount body cannot choose organization or tenant; the server injects them from trusted
configuration. Mutating requests require `application/json`, and cross-origin browser requests are
rejected.

The local HTTP server always requires `SCHIFT_KS_API_TOKEN`, including on loopback, and validates
the literal loopback Host to prevent DNS rebinding. Direct non-loopback binding is not supported in
v0.1 because the built-in server is plain HTTP. The same token is sent by
`schift-ks ... --api-url <url>`; non-loopback remote URLs must use HTTPS. The token is never
persisted or printed. Production exposure should terminate TLS and apply network policy at an
authenticated reverse proxy that forwards only to the loopback listener, or use a Schift Cloud
adapter.

## Portable files and schema subset

The portable directory contains exactly:

- `scope.json`
- every relative `inputSchemaRef` and `resultSchemaRef`
- generated `scope.lock.json`

Symlinks, absolute paths, backslashes, `..`, duplicate JSON keys, missing files, and every undeclared
regular file are rejected. `.schift/` is local state and is never locked or packed; README, license,
credential, PDF, and raw-data files belong outside the portable Scope directory.

The dependency-free schema validator supports:

`type`, `properties`, `required`, `additionalProperties` (boolean), `items`, `enum`, `const`,
`minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, and `maxItems`.

`$ref`, composition keywords, conditionals, formats, unknown keywords, and schema/value nesting
beyond 16 levels fail with `unsupported_schema_keyword` or `schema_depth_exceeded`.
Portable schema numbers are restricted to the cross-runtime safe-integer range. Integral spellings
such as `1`, `1.0`, and `1e0` normalize to one lock value; fractional and unsafe integers are
rejected instead of producing different TypeScript/Python digests.

## State and trust guarantees

- `SCHIFT_KS_HOME` defaults to `~/.schift/knowledge-scope`.
- Directories are mode `0700`; state and the separate 32-byte authorization key are mode `0600`.
- State uses same-directory temp files, fsync, atomic rename, and an exclusive process lock.
- State is capped at 16 MiB and is parsed with the same byte/depth/node ceilings before and after
  every atomic write, so a successful mount cannot make the next read invalid.
- Lock recovery is intentionally fail-closed. If a process crashes while holding `state.lock`, the
  owner must verify the recorded PID is gone before manually removing that lock file; the product
  never auto-deletes a possibly live writer's lock.
- Unmount preserves a tombstone, removes active bindings, and increments mount revision.
- Replacing the authorization key intentionally invalidates outstanding Candidates.
- Provider output cannot set installation, authority, Scope, Pack digest, permission mode, or the
  authorization decision. The HMAC covers SRN, revision, freshness, payload, citation, provider
  scopes/evidence, mounted permission, and every Scope/binding identity used by admission.
- A denied or incomplete run returns no Candidate payloads.

## Verification

From a clean repository checkout, run the root verification commands with Node.js 20+, npm, and Bun:

```bash
npm ci
npm run verify
```

For an already provisioned development workspace, these individual checks are also available.
They require its dependencies, including TypeScript, to have been installed:

```bash
npm run build
npm run typecheck
npm test
node packages/knowledge-scope-cli/dist/main.js --help
```

The repository E2E suite executes Open Connector and Schift Search against local fake HTTP
providers. Release verification additionally dry-packs the artifact, audits its file inventory,
installs it in an empty temporary project, and repeats the portable lifecycle from that installed
artifact. `release:verify` performs these checks in an isolated temporary copy with its own
dependencies and writes a tarball, SHA-256 checksum, and `release-report.json` to the reported
temporary directory. It does not publish a package or deploy a service.

Local fake-provider tests verify software contracts. They do not certify a customer's Search
index, connector account, access policy, or retrieval quality. Use the [pilot gates](docs/PILOT.md#external-pilot-gates)
for those checks.
