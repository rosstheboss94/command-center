# Home updates and archives

Merging source prepares the next version of the factory. Activation is a separate explicit operation. Use the active home's bundled helper, with each argument passed separately:

```powershell
node <home>/skills/ready/cc/scripts/factory.mjs update --home <home>
node <home>/skills/ready/cc/scripts/factory.mjs update prepare --home <home> --ref main
node <home>/skills/ready/cc/scripts/factory.mjs update status --home <home>
node <home>/skills/ready/cc/scripts/factory.mjs update apply <candidate-id> --home <home>
node <home>/skills/ready/cc/scripts/factory.mjs update rollback --home <home>
```

The standalone bundled `scripts/update.mjs` accepts the same subcommands without the `update` prefix. `prepare --destination <path>` may choose a new sibling directory; an existing unrelated destination is never reused. Omitting `--ref` selects verified Command Center `main`. No command accepts an update repository URL. The registered checkout's fetch and push identities and GitHub's repository identity must match `github.com/rosstheboss94/command-center`.

Preparation resolves the ref to an immutable commit, runs dependency installation, discovery generation and source tests, creates an npm tarball, records its SHA-256 digest, and installs from that exact artifact. Nothing is published to npm. The new home receives Codex, Claude and Grok discovery layouts and a managed Command Center clone pinned to the commit. Repository IDs, purpose, checks, provider assignments and explicit workflow choices survive registration refresh; generated facts and Markdown fingerprints are refreshed. The default remains `blocking: false`, with three shared job slots. Frozen jobs are never copied into a new queue or rewritten.

Durable records live in the sibling `.command-center-updates/` directory. `active.json` is the atomic activation record; candidate directories retain configuration snapshots, source, tarball, digest, command logs, stage checkpoints, validation results and a customization report. Installation manifests distinguish local managed-file edits from source upgrades. Legacy homes use committed files as a baseline; historical canonical discovery bytes are reported as stale generated copies. Unknown edits or additions block validation until incorporated into source. Both homes retain their bytes. After correcting source, prepare its new commit rather than editing a candidate.

Preparation is exclusive and resumable. Repeat `prepare` for the same source/configuration to reuse its journal and finished steps. Dead preparation locks recover only after the owner and every recorded child are confirmed absent; live or unverifiable owners prevent recovery. Failed command attempts remain recorded. A candidate with modified files, changed configuration, a mismatched artifact digest, or unresolved customizations cannot activate.

While a dashboard runs it checks verified `main` at launch and every 60 seconds. A new commit triggers one preparation attempt, never activation. Failures are retained for inspection and explicit `prepare` retry. Stopping the dashboard stops further discovery; launch resumes it. Status and candidate notices show preparation progress and failures.

Apply and rollback require idle homes: no unfinished factory jobs, live role children, execution locks, admission leases, queued dashboard operations or conflicting update process. The dashboard scheduler and factory admission paths refuse work during activation. Managed dashboards verify their process identity before stopping; a failed replacement is restored. An older archive without dashboard support receives launch instructions without assuming compatibility. Initial legacy dashboards without a process record must be inspected and stopped explicitly before first cutover.

History shows earlier homes as read-only archives, including original stages, paths, requests, checks and reports. Archive actions cannot resume or modify the old job. “Create successor in active home” saves the exact original request with a prior-job reference, freezes current configuration and starts with no inherited passing evidence. Rollback switches the active record and launch instructions; it does not undo merges, delete either home or discard newer jobs. Old helpers remain physically unchanged, so use the active helper for all new work.
