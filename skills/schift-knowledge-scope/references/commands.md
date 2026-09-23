# Command recipe

## Choose a runner once

Check `node --version`. Preserve an existing CLI/build explicitly selected by the user and inspect its `--help`. Otherwise use this released runner for every call:

```bash
npx --yes --package=@schift-io/knowledge-scope@0.2.0 schift-ks --help
```

Below, `RUNNER` means that whole prefix without `--help`; it is notation, not an executable. Quote paths/questions as literal arguments, never shell code. The runner may fetch npm packages and populate its cache, but does not change application dependencies. Respect offline/network restrictions. Do not install globally, run `npm install` in the user's app, or create an app manifest for skill use.

Read help for capabilities. npm **0.2.0 has `quickstart`/`query`, not `connect`/`ask`/`refresh`**. The latter are unreleased source-checkout additions. Never call them just because this skill describes them. Keep the same runner and `SCHIFT_KS_HOME` across calls; default state is `~/.schift/knowledge-scope`.

Use Node.js 22 or 24 for the `0.3.0` candidate. Its operating boundary is one local OS user, local disk and one network namespace on macOS/Linux. Do not share its state over NFS, between containers/network namespaces or with older writers; do not treat Windows as verified. Local loopback binding must be permitted. This guard is not a data service and does not provide a protocol for reading sources.

## If the selected build advertises connect, ask, refresh

Choose `.schift-ks` under the selected working directory by default, outside the source directory. Do not repurpose an existing project for different material. Read only the selected project's metadata; never discover projects by scanning.

```bash
RUNNER connect './approved-notes' --project './.schift-ks' --json
RUNNER ask 'refund' --project './.schift-ks' --json
```

Easy commands return `installationId`; use that result rather than guessing a metadata path. The selected project's current pointer is `project.json`, not the legacy root `installation.json`. If you need to resume or inspect the pointer, read only that project's `project.json` and follow its recorded mapping.

Inspect the returned installation before establishing/replacing the conversation binding. Repeated `connect` for the same source reuses it; it is not a refresh. For follow-ups use `ask` against the bound project. Another source needs a separate project, not overwrite.

When the user requests refresh:

```bash
RUNNER refresh --project './.schift-ks' --json
```

This manages internal snapshot directories and IDs. Verify the new binding before use. Failure preserves the prior binding/snapshot, not freshness. Old installations are not automatically revoked. `ask` searches stored evidence; it does not reimport original files.

## Released 0.2.0 fallback

Select an unused project destination outside the approved source folder:

```bash
RUNNER quickstart './.schift-ks' --source './approved-notes' --query 'refund'
```

If the destination exists, do not overwrite it. Reuse this conversation's verified binding, inspect an existing project explicitly selected by the user, or select a clearly separate unused destination for newly selected material. Keep the choice in the conversation. Do not infer arbitrary existing directories belong to this source.

Read the resulting `installation.json` yourself; the user need not copy `installationId`. `artifactsComplete: false` is partial setup, not a usable installation. Preserve partial artifacts and follow reported recovery instead of deleting/overwriting.

```bash
RUNNER inspect '<installation-id>'
RUNNER query '<installation-id>' --query 'delivery'
```

Inspect verifies the active mount, sources, tenant and revision against the selected project. A supplied ID/editable file is only a pointer. Bind after verification. Query that ID for each new relevant question. `query` runs the declared `search` operation; do not invent operations for other definitions.

For requested refresh of the same approved source, run `quickstart` into a new unused sibling directory, inspect it, then replace the conversation binding. Manage the internal path/ID yourself; keep the old installation intact and do not switch on failure. Do not modify timestamps, automatically unmount, or claim in-place/automatic sync in 0.2.0. Tell the user the project path to name when resuming later, not an ID.

## Interpret results

Quickstart wraps retrieval under `result`; outer `status: completed` is not evidence success. Legacy `query` returns retrieval `status` directly. For easy commands inspect the documented retrieval envelope, not connection/action status.

On `ready`, check candidates and preserve complete snapshot citation identifiers/source identity with the evidence for audit. User-facing provenance should be short, for example `출처: policy.md, 3–6행 · 연결 시점 자료`. Do not show a long `schift://` identifier by default or format it as a clickable URL; provide it only when the user requests technical provenance. The original file may have changed, and this display is not a source preview.

On `insufficient_evidence`, explain missing support and withhold the claim. Access, inactive-mount, freshness or revision failures suspend retrieval. Reinspect conflicts and reconcile source/tenant/scope; never retry with broader access.

Local limits: 100 files, 1 MiB/file, 8 MiB total text, 4,000 chunks, 2,000 characters/line; traversal stops at 2,000 entries or 16 levels. Hidden entries, `node_modules` and unsupported folder extensions are skipped. Symlinks, hardlinks, special and unstable files are rejected. Explain relevant limits only when blocking; never silently truncate or broaden sources.

## Only when requested: diagnose, disconnect, use hosted sources

After a candidate-version process interruption, retry the intended operation once. Its operating-system guard is released when the process dies; `.project.lock` and `state.lock` **directories** are permanent protective markers, not stale locks to delete. If the error persists or an old regular-file lock is reported, stop mutations and report the exact error without exposing private data. Never remove markers, guess that a PID is dead, run older writers against the same state, or broaden filesystem permissions. Use the [operations guide](https://github.com/schift-io/knowledge-scope/blob/main/packages/knowledge-scope-cli/docs/OPERATIONS.md) for explicit recovery, retention or backup work; verify that the selected runner actually supports each command before running it.

An ordinary question, refresh or conversation closure does not authorize pruning. If the user explicitly asks to remove obsolete snapshots, show the selected project's cleanup preview first, explain irreversible deletion, and apply only the reviewed plan. Do not delete original sources, the current snapshot or another project's material. Cleanup is not secure erasure. No automatic cleanup, unattended version upgrade or broader source scan is part of this skill.

For a selected candidate runner that advertises these commands, preview with `RUNNER prune --project '<bound-project>' --keep 2 --json`; apply only the reviewed response's `plan` using the same arguments plus `--apply --plan '<digest>'`. If interrupted or the plan changes, request a fresh preview. Do not infer cleanup authorization from the availability of a command.

Legacy lock recovery is a distinct operator task: `RUNNER recover --project '<selected-project>' --json` previews; applying the reviewed `plan` additionally needs `--apply --plan '<digest>' --quiesced`. Never supply `--quiesced` without establishing that all state/project writers, including old CLI/SDK processes, have stopped. It is not a process-stop command. Recovery quarantines regular-file legacy locks rather than deleting them; it is not permission to remove new directory markers.

```bash
RUNNER doctor '<installation-id>'
RUNNER unmount '<installation-id>' --expected-revision <inspected-revision>
```

Default doctor does not retrieve (`evidenceVerified: false`). Requested `doctor --probe --query '...'` retrieves and may incur hosted usage. Unmount requires explicit runtime-disconnection intent, retains snapshots and is not secure erasure. Closing conversation use is not that intent.

For requested hosted/SDK integrations use the [released CLI/SDK guide](https://github.com/schift-io/knowledge-scope/blob/v0.2.0/packages/knowledge-scope-cli/README.md). Hosted Search needs an already indexed corpus and authorized configuration; never substitute it for local retrieval silently. Keep credentials in runtime environment, not Pack files/messages.
