# Operate a local KS project

This guide is for the **unpublished `0.3.0` candidate**, not the currently released npm `0.2.0`. Keep routine use simple: connect selected notes once, ask questions, refresh when requested. Read this reference when operating backups, investigating interrupted writes or managing retained data.

## Deployment boundary

- Use Node.js **22 or 24**, macOS or Linux, one local OS user and a local filesystem.
- Every process sharing a project or `SCHIFT_KS_HOME` must share the same filesystem and network namespace. Exclusive loopback socket binding must be allowed. Network filesystems, state shared across containers/network namespaces, Windows and distributed writers are outside this deployment boundary.
- Do not run older and candidate writers against the same state. Keep the exact runner version consistent across the CLI and SDK.
- Local filesystem ownership is the access boundary. Tenant names and conversational bindings do not provide multi-user authentication or enforced session isolation.
- Keep source files, generated project files, state and authorization keys private. Search is local; passages used by an AI assistant are subject to that assistant's transmission and retention policy. Downloading a runner can access npm and populate its package cache.

This is an operating scope, not an assertion that every OS/Node/agent-host combination has passed. Consult the [verification ledger](../../context-pack/AUTO_SCOPE.md) for observed environments and remaining release gates. Automated tests do not replace an independent user's onboarding check or a customer's retrieval-quality evaluation.

## Recover after interruption

First check whether the original command is still running. Do not start another writer to work around an active command. After a terminated process, retry the same intended operation once.

The candidate uses an exclusive local loopback socket as its live-process guard. Process exit, including a forced kill, releases that guard. Owner-only `.project.lock` and `state.lock` **directories remain intentionally**: they prevent older implementations from becoming parallel writers. The socket exposes no data-reading protocol.

Never remove these directories, recursively clear state, weaken permissions, or delete a lock because its recorded PID appears absent. PID reuse and parallel writers make that unsafe. A legacy `0.2.0` regular-file lock fails closed instead of being silently converted.

### Recover a legacy lock

Use this only when the selected candidate build advertises `recover` in `--help`. It is not needed for normal candidate-process crashes. In a built source checkout, preview the selected project:

```bash
node packages/knowledge-scope-cli/dist/main.js recover --project './.schift-ks' --json
```

Before applying, stop **all** writers using that project or state directory, including legacy `0.2.0` processes and SDK consumers. Review the exact files and digest in the preview. `--quiesced` is your assertion that this has been done, not a command that stops other processes. Then use the reviewed `plan` value:

```bash
node packages/knowledge-scope-cli/dist/main.js recover --project './.schift-ks' \
  --apply --plan '<reviewed-plan-digest>' --quiesced --json
```

Recovery quarantines the old lock files instead of deleting them, and installs the new protective markers. It still refuses a live recorded state-lock owner. If the preview changes, a writer remains active, or the runner does not offer this operation, stop and resolve that condition; do not fall back to manual deletion. This does not restart a service, restore lost data or make an old writer safe to run alongside the candidate.

An interrupted refresh can leave unused artifacts, but should not authorize stale evidence or a different source. Confirm the selected project still resolves with `ask` or inspect its recorded installation. A successful retry must return evidence admitted under the selected project's current rules; command completion alone is insufficient.

Writes use synced temporary files, atomic rename and parent-directory sync. Fault-injection/process-crash tests exercise publication boundaries. They do **not** certify hardware power-loss behavior on every disk, filesystem or operating system. Keep recoverable backups.

## Back up and restore

1. Stop all writers using the selected project **and** its KS state location. A copy taken while either changes is not a consistent backup.
2. Copy the complete project and the complete matching `SCHIFT_KS_HOME` together into a private, owner-only local backup destination. Preserve permissions. State includes retained source text and authorization material; treat the backup as sensitive as the original. If several projects share the state location, preserve their matching project directories too.
3. Preserve the exact runner version and state-location mapping in your private operational record. Back up the approved original source separately if future refresh is required; snapshots are not a substitute for that source. Do not publish the backup or attach it to an issue.
4. To test restoration, use a separate local project destination and a separate state directory. Set `SCHIFT_KS_HOME` to the restored state explicitly. Stop writers while restoring; do not overlay a live state directory or mix an old project pointer with newer state/key files.
5. With the matching runner, inspect the restored installation and execute a known `ask` (or `query` for a legacy project). Verify the expected filename, citation and content. Expired evidence must remain expired; refresh only from the approved source on an explicit request. A passing filesystem copy is not restore verification.

Only promote a tested restoration after stopping the old writers. Source paths embedded in the project may still refer to their original location; do not refresh a relocated backup until that mapping has been reviewed. Keep the prior backup until recovery is confirmed.

### Downgrade

Do not remove protective lock markers to let `0.2.0` write candidate state. Downgrade only by restoring a validated, version-compatible backup into an isolated project/state location and using its matching runner. Without that backup, retain candidate state and resolve the candidate failure; an in-place downgrade is not a recovery method.

## Retained data

Refresh retains older installations and stored text; conversation closure and `unmount` do not erase that data. There is no automatic deletion timer. Check storage use and choose a retention count appropriate to your own recovery needs.

The candidate's cleanup workflow is preview first, then an explicitly reviewed plan. Before using it, check `--help` on your selected build: the published `0.2.0` runner has no `prune` command. Never substitute shell globs or manual state-file edits for cleanup.

From a built source checkout, preview keeping two project snapshots:

```bash
node packages/knowledge-scope-cli/dist/main.js prune --project './.schift-ks' --keep 2 --json
```

Review the returned plan before applying it. `--keep` accepts 1–100 and defaults to 2; the current snapshot is always protected. Use the same project, state location and retention count, with the returned `plan` digest:

```bash
node packages/knowledge-scope-cli/dist/main.js prune --project './.schift-ks' --keep 2 \
  --apply --plan '<reviewed-plan-digest>' --json
```

The apply operation revokes and removes obsolete installation IDs, and removes stored text only when no retained reference needs it. Material shared with another installation remains. Original source files are not cleanup targets. A changed plan must be previewed again; do not force an old digest. If cleanup is interrupted, obtain and review a fresh preview before retrying; its cleanup journal supports completing the interrupted operation.

The preview also lists owned incomplete builds left by failed or interrupted setup. The current project stays protected. Unknown old directories and unverified raw temporary files are left in place for manual investigation; the command will not guess that they are safe to remove. After a failed first connection, fix the approved source and connect successfully before using project cleanup.

Cleanup must retain the current snapshot and material still referenced elsewhere. Removal of obsolete state/text is irreversible without a backup and is **not secure erasure** of disk blocks, backups or existing AI conversations. Back up first if that history is needed for an audit or rollback.

## Incident and release checks

- On access, integrity or revision failure, withhold evidence. Do not retry using another tenant, source or broader permissions.
- Share runner/Node/OS versions, the error code and sanitized reproduction steps. Do not share state files, authorization keys, raw passages or private paths.
- Verify a clean package installation, basic connect/ask/refresh, no-match behavior, interrupted-write recovery, concurrent-writer refusal, retention preview/apply and restore before unattended use.
- Record the exact tested artifact and environment. Publishing to npm, a green build, and real-user acceptance are separate gates. This candidate guide does not imply publication or an independent human pilot has happened.
