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
   This is the Open Connector product in `core-dependencies/schift-connector`.
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
- [x] Public source and developer guides at
      [schift-io/knowledge-scope](https://github.com/schift-io/knowledge-scope), with independent
      TypeScript/CLI and Python verification workflows and no private monorepo history.
- [x] Public [v0.1.0 release](https://github.com/schift-io/knowledge-scope/releases/tag/v0.1.0)
      includes the exact approved npm archive and SHA-256 manifest;
      [GitHub CI](https://github.com/schift-io/knowledge-scope/actions/runs/35728138385)
      passes both TypeScript/CLI and Python jobs.

## Account-free first use — 0.2.0 published and registry-verified

User: an AI application developer with local Markdown or text, but no Schift account.
Job: select their own material, ask a question, inspect cited evidence, and reuse it in an app.
Done when: a clean installed artifact completes this path without network, model, or provider credentials.
Primary action: `schift-ks quickstart <new-workspace> --source <path> --query <question>`.

```text
Choose .md/.txt file or folder -> bounded private local snapshot -> cited retrieval
  -> inspect ready/insufficient evidence -> query again or consume through SDK
```

- [x] Add portable local-document provider identity and matching TypeScript/Python admission.
- [x] Import bounded UTF-8 text into an owner-only snapshot outside the portable Pack.
- [x] Retrieve lexical matches with content revisions and line citations; reject unsafe files,
      unsupported filtering, missing snapshots, and inadequate evidence.
- [x] Add account-free quickstart and repeat-query commands while preserving hosted setup.
- [x] Document one local start path, supported formats, snapshot refresh, and app consumption.
- [x] Verify actual-file CLI, restarted SDK, isolation/failure paths, and clean installed artifact.
- [x] Fix a reproduced source-ancestor swap before accepting imported text; verify selected file
      identity, reject hardlinks, and preserve typed redacted errors across CLI and HTTP.

Verification (2026-09-22): 237 CLI/SDK tests, 63 TypeScript contract tests, and 141 Python contract
tests passed. Isolated release build/typecheck, existing hosted/batch smoke, and the new installed
Node.js local-file smoke passed. The latter covers Korean retrieval, line citations, no-match
withholding, restarted SDK, snapshot reuse/refresh, foreign-scope denial, and unmount revocation.
Local HTTP and expired-snapshot tests passed; independent security re-review found no remaining
confirmed blocker within the filesystem-owner boundary. This is not a sandbox against malicious
processes with the same OS identity. Dependency audit reported zero known vulnerabilities.

The final npm-first guide is included in the published `schift-io-knowledge-scope-0.2.0.tgz`:
SHA-256 `37d36d943d7769b0bfeac604d2f60ab5a6d2173710548ff690923082d961097d`.

- [x] Public source and v0.2.0 tag point to `117900627f2bf31d7aeeec3a49751bcd8f730a76`.
- [x] Both [GitHub CI jobs](https://github.com/schift-io/knowledge-scope/actions/runs/35733931716)
      passed against that source.
- [x] [npm v0.2.0](https://www.npmjs.com/package/@schift-io/knowledge-scope/v/0.2.0) is published
      with `latest: 0.2.0` and the public repository link.
- [x] Registry-downloaded archive SHA-256 exactly matches the approved release file.
- [x] Fresh package-name install passed the local-first-use/restarted-SDK/snapshot/revocation
      checks and the existing synthetic hosted Search/combined document-record lifecycle.
- [x] [GitHub v0.2.0 release](https://github.com/schift-io/knowledge-scope/releases/tag/v0.2.0)
      is public with the same npm archive and checksum manifest.

Publication evidence (2026-09-22): registry metadata initially lagged the successful publish
response, then resolved to 0.2.0. Installed verification used a fresh cache with `--prefer-online`.
No duplicate publication or version substitution was used.

Implementation introduced no new dependencies and included no customer data or provider/account
configuration. Public distribution was separately approved; only the curated Knowledge Scope
repository and npm package were uploaded, not the private monorepo. Existing shared contracts stay
additive. PDF/office parsing, URL fetching, MCP, semantic retrieval, and managed sync are separate
lanes; this local lexical path must not claim to implement them.

## Agent-assisted use and explanation guide — published and verified

User: a developer deciding whether KS belongs in their app, or an agent using a selected KS project.
Job: understand the input/output boundary and safely complete setup, repeated retrieval, and recovery.
First action: choose the CLI/SDK guide or bind selected knowledge to this conversation with the
[official usage skill](../../skills/schift-knowledge-scope/SKILL.md).

- [x] Add a self-contained usage skill and host metadata without modifying the execution runtime.
- [x] Explain where KS fits, when direct file search is simpler, and which responsibilities stay with the app.
- [x] Add a [Korean usage guide](../knowledge-scope-cli/docs/USAGE.md) for installation, result interpretation,
      generated files, retained private state, refresh, disconnect, and provider prerequisites.
- [x] Add an [observed example](../knowledge-scope-cli/docs/DEMO.md) using the published npm package;
      distinguish selected JSON fields from full responses and admission from answer relevance.
- [x] Verify project-local skill discovery/installation into Codex and Claude Code directory layouts.
- [x] Independently run the installed skill with selected synthetic sources, a supported question,
      an unsupported question, and untrusted instructions inside evidence.
- [x] Preserve declared source boundaries and cite results; withhold unsupported claims even when
      lexical overlap yields a ready but irrelevant passage.
- [x] Validate skill metadata, documentation links/anchors, and local Markdown previews at mobile
      and desktop widths; public source build/typecheck and 63 contract + 237 CLI/SDK tests pass.
- [x] Make the usage skill session-based: select once, reuse for follow-ups, suspend on failed
      validation, require selection in a new conversation, and verify explicit project switches.
- [x] Run independent two-conversation tests: A follow-up reuse, unbound new conversation,
      explicit B selection and switch, and session close without unmount or data deletion.
- [x] Publish the skill and explanation changes to the approved public repository at
      [76cae51](https://github.com/schift-io/knowledge-scope/commit/76cae51d2f27237b7d7651e965cd994c42ec906a).
- [x] Install the published skill into fresh project-local Codex and Claude Code layouts;
      both copies match the published source and pass skill validation.
- [x] Verify public Python and TypeScript CI on that implementation revision:
      [successful run](https://github.com/schift-io/knowledge-scope/actions/runs/35754342213).

The independent agent reused one installation across separate CLI processes. This does not certify
automatic skill selection in every host/version, future agent-session continuity, or general
prompt-injection resistance. No global skills, runtime dependencies, npm version, or private
customer sources were changed. The usage skill is not the proposed Let Skill compiler or an MCP server.

Session binding is assistant workflow, not runtime session isolation. It adds no session database,
automatic lifecycle hook, implicit global default, or permission bypass; previous chat history
is retained according to the host, and existing installation state remains independent.


## Simpler first use — locally verified, not published

User: a developer using approved project notes in an existing AI conversation.
Job: connect those notes once, ask follow-up questions, and refresh changed notes
without copying installation IDs or creating replacement project directories.
Flow: install the skill once → choose the source → ask with citations → refresh
the same selected project when needed. Source scope, retained local copies, and
evidence passed to the AI host remain visible; internal revisions do not.

Implementation and behavior-preservation plan:

- [x] Add `connect`, `ask`, and `refresh` with a project-local default and an
      explicit `--project` override. No global last-used project.
- [x] Reuse the existing local importer, mount validation, freshness policy, and
      query path. Preserve all existing CLI/SDK commands and JSON contracts.
- [x] Keep a private project pointer; prepare refreshed snapshots separately and
      replace the pointer atomically only after success. Never implicitly delete
      or revoke retained installations; failed refresh preserves the old pointer.
- [x] Ignore generated private project metadata in ordinary Git adds without
      changing the customer's repository-level ignore rules.
- [x] Return readable evidence and actionable recovery for the new commands;
      retain `--json` for agents and programmatic consumers.
- [x] Let the session skill run the pinned CLI without modifying the customer's
      application dependencies; keep a verified path for published `0.2.0`.
- [x] Verify new and existing behavior with unit tests, real Node CLI scenarios,
      isolated package installation, typecheck, and terminal-output review.
- [x] Forward-test the skill from fresh conversations on the local build and
      published `0.2.0`: first answer, same-session follow-up, and requested
      refresh all succeeded without user-managed IDs. See [observed checks](../knowledge-scope-cli/docs/DEMO.md#simpler-first-use-check--unpublished-source-changes).
- [ ] Publish these implementation and skill updates after separate approval;
      do not infer this from the earlier approved `0.2.0` publication.

Final local verification: 63 contract tests and 283 CLI/SDK tests passed in the
public checkout; build and typecheck passed. The isolated release verifier built
and installed a tarball, checked the SDK and local flows, and passed the new
connect/ask/refresh smoke. The strict TypeScript static checker found no
violations in the 11 changed source/test files. Both terminal review passes
accepted the 80-column help and Korean-evidence samples. No remote CI or
publication is claimed for these unpushed changes.

This track does not add semantic search, PDF parsing, session ACLs, automatic
sync, or model generation. Public npm remains `0.2.0`; new command availability
must be checked against the selected binary until a separately approved release.

## Local production hardening — candidate verified locally

Release scope: single-user local Markdown/text retrieval on local macOS/Linux
filesystems with supported Node LTS majors. This does not certify distributed
filesystems, shared storage across network namespaces, Windows, or enforced
session/tenant isolation. Customer answer generation remains external.

Plan (tests first, no publication implied):

- [x] Replace persistent-file lock ownership in both project and runtime state
      with a kill-released local guard; preserve fail-closed legacy-lock handling.
- [x] Fsync project/snapshot parent directories and verify injected write/sync
      failures and killed-writer restart behavior.
- [x] Add preview/plan-bound explicit pruning of obsolete project revisions,
      raw snapshots and runtime records; protect active and shared references.
- [x] Define the supported OS/Node contract and configure the same CI matrix.
- [x] Verify exact-candidate install and upgrade from published `0.2.0` without
      breaking existing installations or source material.
- [x] Update the session skill and operator guidance for recovery, storage,
      backup/restore, downgrade boundaries and unsupported environments.
- [x] Run independent review, fault/kill/concurrency tests, real installed CLI
      paths and supported runtime checks; distinguish configured CI from run CI.
- [x] Push the public source to [GitHub `main`](https://github.com/schift-io/knowledge-scope/commit/48f74acc89deaf703ed99a070c5653cbdddd755e)
      and verify [remote CI](https://github.com/schift-io/knowledge-scope/actions/runs/35820172748):
      Python plus macOS/Ubuntu Node 22/24 all succeeded.
- [ ] Publish npm `@schift-io/knowledge-scope@0.3.0` only with separate approval.
      Real customer activation remains the external gate below.

Candidate `0.3.0` package SHA-256:
`a49827e9b6ffa3603d71bd1cad50bb6c7f73b19eab5f8e481bcbcbaa1ca36132`.
The isolated verifier built and installed this exact tarball: 333 CLI/SDK tests,
63 Context Pack contract tests, strict typecheck, zero reported production
dependency vulnerabilities, legacy `0.2.0` upgrade, maintenance, and actual
Node SIGKILL recovery all passed. The same tarball passed installed checks on
macOS arm64 Node 22.22.1 and Linux x64 Node 22.23.2; Linux x64 ran in an
emulated local container. The remote GitHub Actions run above checked the
updated source on macOS and Ubuntu with Node 22 and 24. Independent customer
validation is still open.

An interrupted candidate writer releases its local guard. Legacy file locks
require explicit reviewed recovery and confirmation that old writers stopped.
Retention cleanup requires an exact preview plan and explicit apply; it protects
the active installation, shared references and original source files. Unknown
old orphan directories and unverified temporary files remain fail-closed for
operator review. Backups and prior assistant conversation copies are not erased.
The candidate source is on GitHub. npm `0.3.0` has not been published, and the
product has not been tested with independent customers.

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
