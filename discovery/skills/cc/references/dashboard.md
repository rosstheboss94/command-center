# Local Kanban dashboard

Ask `cc dashboard` in a home, or run:

```sh
command-center-dashboard --home <home> --host codex
node <cc-skill>/scripts/factory.mjs dashboard --home <home> --host codex --port 4310
```

Use the actual invoking host: codex, claude, or grok. The helper prints a loopback URL. An occupied port fails explicitly; `--port 0` chooses an available port. Ctrl+C stops the server. Dispatched workers continue independently; pending entries wait for the next session. Do not expose it through a public proxy.

The sidebar contains All repositories, registered repos, and Settings. Repo, search, stage, and Board/History selection are URL parameters. Cards combine GitHub issues and local jobs. Columns are Queued, Intake, Spec, Plan, Build, Verify, Review, Approve, Deliver, Ready for merge, Done, and Blocked. Blocked cards identify their interrupted step. Done requires verified GitHub completion; Ready is not a merge. Completed work may retain an older blocked local record, shown without rewriting evidence. Done shows the past 30 days; History includes older completed work and rejected jobs.

Local state refreshes every two seconds and GitHub every 30 seconds while visible. GitHub requires authenticated gh and a verified registered identity. Failed syncs retain the last snapshot with its age. Local repos remain inspectable, but issue operations require GitHub. Legacy Markdown jobs require normal adoption before execution.

Create issue queues a request without starting it. Start runs one issue; Run queue snapshots the selected repo, or all repos. New issues wait for another explicit run. Execution uses the existing worktrees, frozen checks, provider assignments, and approval gates. Cards cannot be dragged to bypass stages. Exhausted builds need a successor or direct work. Merge and publishing remain separate.

Settings offers prepare/confirm registration, confirmed base branches, validated checks and setup gaps, and future-job runners, models, timeouts, and limits. Provider changes clear model choices. Markdown conflicts require explicit review and reconciliation. Saves wait for active jobs to finish so they cannot interrupt role integrity checks; pending saves appear on the board. Existing job inputs and evidence remain frozen.

Home admission defaults to three jobs, configured in `repos/factory.json` as `{"concurrency":3}`. Per-repo limits still apply; CLI and dashboard starts share the home lease. This operational cap does not rewrite frozen job settings. Lowering capacity waits for running jobs. Older helpers do not participate: finish old-version processes before relying on the shared cap. Stale leases are never automatically ignored.

Operation records and worker logs live under `.cc/dashboard/tasks/`. Duplicate pending clicks reuse the existing operation. Dead workers become interrupted instead of silently replaying side effects. Inspect and recover checks saved owners and children, uses normal `cc recover` for a dead execution owner, and retains any required feedback. A live child prevents recovery. If issue creation was interrupted before its result was recorded, inspect GitHub before creating it again. Operations without a saved job identity require manual reconciliation. Errors never change providers or invent evidence.

The server rejects foreign Host/Origin requests, requires a launch-session token for writes, uses a restrictive content policy, and renders issues and logs as text. This is a local single-user application. It never migrates an installed home automatically. Local fixtures do not prove real host discovery or provider authentication.
