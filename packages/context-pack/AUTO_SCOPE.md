# Knowledge Scope product boundary and status

Auto-Scope may inspect explicitly authorized material and propose a Knowledge Scope, but it is not
an authority service or hosted model backend. Generated output remains a candidate until a trusted
installation owner validates and mounts it.

## Portable contract — done

- [x] Portable `KnowledgeScopeDefinition` with stable `responsibility`, query capabilities,
      structural Context policy, authority, and evidence policy.
- [x] Server-owned `KnowledgeScopeMount` separated from the definition, with opaque installation,
      Scope authority, bindings, mounted state, and monotonic revision.
- [x] Definition-only digest and lock covering `scope.json` and every referenced schema checksum.
- [x] Deprecated combined `KnowledgeScopePack` retained only as a materialized compatibility view.
- [x] Named providers for records operations, Open Connector actions, Schift search, and web search.
- [x] Provider-neutral `CandidateEnvelope` bound to installation, definition digest, mount revision,
      operation, effective Scope, authorization decision, permission, revision, evidence, and citation.
- [x] TypeScript and Python canonical JSON/digest conformance fixtures.
- [x] Pure admission gate for mount state, Scope narrowing, trusted decision, source/operation/
      provider binding, `mustNotUse`, authority, connector audit/scopes, citation, and freshness.
- [x] Aggregate admission enforcing every coverage assertion and unique-evidence `minEvidence`.
- [x] Strict provider result contract that cannot mint permission, mount, or authorization identity.

## Local CE product — done

- [x] Installable `schift-ks` CLI: init, validate, lock, mount, inspect, run, run-batch, admit, unmount, serve.
- [x] Token-authenticated, DNS-rebinding-resistant loopback HTTP API backed by the same application
      and atomic local state; direct non-loopback serving is rejected.
- [x] Owner-only state/key permissions, fsync + atomic rename, process lock, revision conflicts, and
      unmount tombstones.
- [x] HMAC authorization decisions that survive restart and fail after explicit key replacement.
- [x] Open Connector action adapter using its public runtime API, Scope-bound idempotency,
      connector/action read-only attestation, action/run correlation, persisted audit requirement,
      and bounded streaming response reads.
- [x] Schift Search adapter using authenticated v2 status + retrieve calls with credential-bound
      organization identity plus evidence-grade source, revision, freshness, citation, and index
      identity.
- [x] Injected named-records execution port; no raw SQL or provider predicate surface.
- [x] Dependency-free bounded JSON Schema subset for operation input and provider result validation.
- [x] Subprocess E2E for two provider capabilities and fail-closed negative cases.
- [x] Standalone bundle, public SDK entry, declarations, package inventory audit, and clean-consumer
      install smoke. See [`../knowledge-scope-cli/README.md`](../knowledge-scope-cli/README.md).

## Adapter contract

1. A provider executes an already allowlisted operation. Schift does not accept raw SQL, provider
   query syntax, or credentials in the portable contract.
2. The adapter returns evidence facts only. The local control plane supplies mount, Scope,
   permission mode, and HMAC authorization identity before producing `CandidateEnvelope`.
3. `admitKnowledgeScopeCandidate` / `admit_candidate` evaluates the envelope against the mounted
   Scope before any downstream context consumer sees it.
4. Open Connector keeps provider catalog, OAuth, credentials, action execution, and run logs. Schift
   retains only the declared `operationId` → `actionId` mapping and correlation identifiers.
   Open Connector is a separately operated service; its source is not included in this repository.
5. Schift Search currently accepts tenant-root execution backed by its organization/bucket ACL.
   `namespace`, `subject`, and `session` narrowing fail before HTTP because v2 Search does not enforce
   those fields. A local Scope label alone does not establish provider data isolation.

## Pilot integration kit

- [x] Typed `createKnowledgeScopeClient({ application })` with inspect, run, runBatch, and batch admission;
      validates response identity and receipts before returning evidence.
- [x] Search quickstart creates a locked Pack, local bindings, input, and mount, then runs the
      declared `search` operation against an existing index.
- [x] Configuration-only doctor plus explicit read probe; preserved workspace and recovery command
      after provider failure.
- [x] Installed consumer example returns cited evidence without selecting or calling a model.
- [x] Offline retrieval evaluation with pinned inputs, explicit metric denominators, forbidden
      evidence counts, and comparison checks; synthetic fixtures do not establish customer accuracy.
- [x] Developer quickstart and customer pilot guide distinguish configuration, local fake-provider
      proof, live-account acceptance, and commercial validation.
- [x] Isolated release verification: fresh locked dependency installation, build/typecheck,
      product tests, tarball inventory, installed CLI/typed SDK and shipped consumer/evaluation examples.
- [x] Multi-operation requests validate all inputs before dispatch and combine document/record
      coverage under one mount, with no partial Candidate output on failure.
- [x] Curated batch declarations and shared TypeScript/Python request contracts; Python supplies
      contract/admission interoperability, not a separate provider-execution runtime.
- [x] Installed CLI/SDK batch smoke using local synthetic Search and read-only Open Connector,
      including independently insufficient runs, restart admission, and unmount denial.
- [x] Public npm publication of `@schift-io/knowledge-scope@0.1.0`, tagged `latest`; the downloaded
      registry artifact matches the approved SHA-256 and passes the installed CLI/SDK lifecycle smoke.

## External validation — open

Use the [support-context pilot guide](../knowledge-scope-cli/docs/PILOT.md) to run customer trials.
Engineering completion and customer validation are separate acceptance criteria.

- [ ] Live customer Search/Open Connector account certification.
- [ ] 30–50 customer-reviewed questions with expected evidence and a held-out subset.
- [ ] Comparable source snapshots and measured retrieval results against the customer's baseline.
- [ ] Three external activations by day 30, two repeat users by day 60, and one paid continuation
      by day 90. These are proposed pilot gates, not observed results.
- [ ] Measured support effort, operating cost, and repeatable second-customer installation.

## Deliberately not implemented here

- [ ] Synchronized external-provider snapshots or distributed transactions. Batch execution
      guarantees atomic admission/output; each provider keeps its own revision and freshness.
- [ ] Hosted Auto-Scope generation or model routing.
- [ ] Automatic publication or authority elevation.
- [ ] Provider credential custody. Open Connector continues to own its OAuth and connection store.
- [ ] Agent, Workflow, Runtime/A2A, or Observer backend behavior.
- [ ] Schift Cloud multi-tenant persistence, production deployment, or live provider-account
      certification.

Those implementation lanes remain outside this pilot kit. Deployment and live-account work remain
separate operational actions. The CE product stops at bounded provider execution, Candidate
normalization, and admission evidence.
