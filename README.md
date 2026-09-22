# Schift Knowledge Scope

Give an AI application a reusable definition of **which project data to read, what evidence to
return, and when to withhold it**. Start with Markdown or text files, retrieve passages with source
references, then use them with the model you choose.

Try the local CLI below, or [use the official skill with a coding agent](#use-with-a-coding-agent).
[한국어 사용 가이드](packages/knowledge-scope-cli/docs/USAGE.md) walks through the same workflow.

## Get your first cited result

You need Node.js 20 or later. Run this in your application directory. No Schift account, API key,
cloud service, or model is needed for local retrieval after the npm installation:

```bash
npm install @schift-io/knowledge-scope@0.2.0
npx --no-install schift-ks quickstart ./support-project \
  --source ./node_modules/@schift-io/knowledge-scope/examples/local-documents/support-handbook.md \
  --query '환불 규정'
```

Use a new destination directory. The handbook is synthetic: expect `result.status: "ready"` and
a candidate containing its 22-line text, including the 14-day refund window, with citation label
`support-handbook.md:L1-L22`. This is retrieved evidence, **not a generated answer**.
Save the returned `installationId` and ask another question:

```bash
npx --no-install schift-ks query '<installation-id>' --query '배송 기간'
```

See the [observed result and no-match case](packages/knowledge-scope-cli/docs/DEMO.md).
The captured example distinguishes command completion, evidence admission, and answer relevance.

Then use your own UTF-8 `.md` or `.txt` file, or a folder containing those files:

```bash
npx --no-install schift-ks quickstart ./my-project \
  --source ./my-documents --query '환불 규정'
```

Local search matches words in the source; it does not use embeddings or reranking. Start with
terms that actually occur in your files. PDF, Office files, URLs, and crawling are not included.
See the [local example](packages/knowledge-scope-cli/examples/local-documents/README.md) and
[full quickstart](packages/knowledge-scope-cli/README.md#quickstart) for file limits and recovery.

## Where does KS fit?

```text
Your question + selected project
                ↓
KS reads the project's configured data sources
                ↓
KS checks returned evidence against declared requirements
                ↓
Admitted passages/records + citations, or insufficient evidence
                ↓
Your application → your chosen model → your answer UI
```

The input is a question or a declared operation's structured input, plus the installed project's
identity and access context. The output contains candidate evidence, source references, and an
admission result. Your application decides what to do next; KS does not call your answer model.

“Admission” means checking evidence against configured requirements, such as allowed scope,
required evidence, revision, and freshness. It does **not** mean a passage is factually correct,
answers the question, or is safe to obey as an instruction.

KS is not a database replacement, an agent framework, or a complete semantic RAG engine. It sits
between data-reading code and its consumers. Existing databases and search services still store
data and implement the reads you connect.

## When is it worth adding?

KS is intended for AI application teams, SI firms, agencies, and private-AI operators that need
to reuse project-specific retrieval definitions without mixing them with deployment credentials
or model-specific prompts.

- **Use a direct file read or `grep`** for a one-off question over a small folder. KS adds setup
  and state; you do not need it just to find a sentence.
- **Keep a simple RAG integration** if one application already handles its sources, citations,
  and failure conditions adequately. KS does not automatically improve your search ranking.
- **Consider KS** when several consumers need the same declared operations and evidence rules,
  each customer project needs separate bindings, or the app must reject incomplete evidence
  before passing it to a model.

The question is whether reusable definitions and checked outputs reduce the retrieval glue your
team maintains—not whether adding KS makes every answer better.

## Use with a coding agent

The [official `schift-knowledge-scope` skill](skills/schift-knowledge-scope/SKILL.md) guides an
agent through installing the CLI, connecting only material you select, reusing the resulting
installation, and presenting retrieved evidence with citations.

Install the skill from this repository with the separate Skills CLI:

```bash
npx skills add schift-io/knowledge-scope --skill schift-knowledge-scope
```

Review the offered target agent and installation scope. To try a local checkout of this repository
instead, run `npx skills add . --skill schift-knowledge-scope` at its root. The skill lives in
this GitHub repository; it is **not bundled in npm 0.2.0**. Skill installation and KS runtime
installation are separate steps.

Then ask your agent:

> Use schift-knowledge-scope to connect `./my-documents` to a new local project. Find the refund
> policy and show the supporting passage and citation. Do not upload these files to a service.

Or: “이 폴더를 KS로 연결하고, 환불 규정의 근거와 출처를 찾아줘. 외부로 업로드하지 마.”

This is an instruction-based usage skill, not a bundled MCP server or the proposed Let Skill
compiler. It cannot grant access, override runtime checks, or guarantee that every agent host
will load or follow it. Your agent's existing file and tool permissions still apply.

Local-checkout installation was verified in isolated project folders for the Codex and Claude Code
directory layouts. An independent agent followed the installed skill through setup, cited retrieval,
and an unsupported question. This is not certification of automatic selection in every host/version.

## Use from your application

After quickstart, run the included SDK consumer using the same local state:

```bash
node node_modules/@schift-io/knowledge-scope/examples/consumer.mjs \
  '<installation-id>' local-tenant '환불 규정' search
```

`local-tenant` is the local quickstart default; use your configured tenant if you changed it.
The example prints a typed result, never calls a model, and exits with code 3 for insufficient
evidence. See [the source](packages/knowledge-scope-cli/examples/consumer.mjs) and
[SDK setup](packages/knowledge-scope-cli/README.md#use-the-evidence-in-your-application).

In your app:

1. Reuse the installation and submit the declared operation through `client.run(...)`.
2. Check `result.status`, not merely whether the command completed.
3. Only when it is `ready`, pass `result.candidates` to context assembly and retain citations.
4. On `insufficient_evidence`, withhold the answer or request missing material. On an error,
   fix the reported connection or access problem; do not substitute unverified evidence.

`createKnowledgeScopeClient({ application })` also provides `inspect`, `runBatch`, and `admit`.
The local application loads CLI state; a remote application uses the authenticated HTTP API.
Your app owns user authentication, prompts, model calls, and answer rendering. Sending private
passages to an external model is your application's separate data-handling choice.

## What gets saved, and what can I share?

Quickstart creates portable files under the project's `pack/` directory and installation-side
files alongside it. The Pack describes operations and evidence requirements; deployment bindings
tell the runtime where those operations are available.

- **Portable Pack:** definition and lock material. The generated local Pack does not embed source
  text, absolute source paths, or credentials. Review manually authored content before publishing:
  a format is not a secret-removal service.
- **Local project files:** bindings and installation metadata are deployment-specific. Do not
  treat the entire quickstart directory as a portable Pack.
- **Local runtime state:** imported text snapshots and mount state live outside the Pack.
  Keep them private. CLI and SDK must use the same state directory (`SCHIFT_KS_HOME` if set).

Local citations use `schift://local-documents/...#Lx-Ly` to identify captured evidence, not public
URLs or file-opening links. A returned `sourcePath` may refer to an original that has since changed.

**Imports are snapshots, not live sync.** Editing original files does not update an installation.
The generated local policy accepts snapshots for 24 hours after import. Refresh by importing into
a new project directory and use its new installation; changing a timestamp is not a refresh.
Unmounting revokes an installation but does not delete retained text.

Local state uses owner-only filesystem permissions. A project or tenant label is not user
authentication, a multi-user sandbox, or live document-ACL enforcement. Do not expose local
installations to other users without an application authorization boundary.

## Three concrete uses

**Project handbook — available locally.** Connect approved text and Markdown, ask questions, and
retain source passages and line ranges in a support or documentation app. This is the account-free
path above.

**Several customer projects — configure each separately.** Reuse an appropriate policy/template
and create an installation for each approved source. Local quickstart embeds the snapshot's opaque
reference in its definition, so different snapshots are not automatically the same Pack digest.
Your application must select the correct installation and enforce caller access; different
project names do not establish tenant security.

**Policy plus an order record — integration required.** Connect document search and an authorized
read-only order lookup, declare both operations, and use `runBatch` to admit their evidence
together. This is not a turnkey refund bot or an arbitrary SQL connection. You supply the sources
and required-evidence rules. Atomic output is not a shared database transaction or synchronized
snapshot across providers. See the [combined example](packages/knowledge-scope-cli/examples/batch-consumer.mjs)
and [document-plus-records pilot](packages/knowledge-scope-cli/docs/PILOT.md#extend-to-documents-plus-live-records).

Documents and records are two source classes, not competing database choices. Documents can use
local lexical search or an already populated Schift Search index. Records can use an injected
named-records execution port or an authorized Open Connector operation. Open Connector is
separately operated; its runtime is not included. Hosted adapters need their own endpoints and
credentials. See [provider setup](packages/knowledge-scope-cli/README.md).

## Guides and current boundaries

- [한국어 사용 가이드](packages/knowledge-scope-cli/docs/USAGE.md): first result, repeated use, and recovery.
- [Reproducible example](packages/knowledge-scope-cli/docs/DEMO.md): actual selected output fields and an unsupported-question check.
- [SDK and CLI reference](packages/knowledge-scope-cli/README.md): providers, limits, and commands.
- [Evaluation example](packages/knowledge-scope-cli/examples/evaluation/README.md): compare captured
  results against a reviewed evidence set; the synthetic example makes no accuracy superiority claim.
- [Pilot guide](packages/knowledge-scope-cli/docs/PILOT.md): test a customer's workflow.
- [Implementation status](packages/context-pack/AUTO_SCOPE.md): completed work and open validation.

The [Python package](packages/core/context-pack/python) mirrors portable contracts, canonical
digests, and pure admission checks. It is not a Python provider-execution runtime or CLI.
There is no bundled PDF/URL ingestion, continuous sync, MCP server, or answer-generation UI.

## Develop and verify

Install Node.js 20+, npm, and Bun, then run from the repository root:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify
```

`verify` exercises release packaging and the installed-consumer path; it does not publish or
deploy. Synthetic provider tests do not certify a live account, access policy, or retrieval quality.

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
