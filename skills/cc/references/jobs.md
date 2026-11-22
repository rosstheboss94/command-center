# Jobs and recovery

## Create and preserve context

Resolve the registered checkout and confirm its Git identity. Report missing checkouts or mismatched remotes as blockers. Read central configuration and current project instructions. Preserve user edits. Use a dedicated branch or isolated worktree per job and record its exact path and base commit.

Use the config's generated Instruction scope data when present. Root rules apply across the checkout, while nested rules apply only within their directory. Legacy flat instruction lists retain each file's directory scope. Read the Check validation limits and setup gaps before treating the saved checks as ready for a job.

Create a unique UTC timestamp plus short random suffix under `jobs/<repo-id>/<job-id>/`. Save the exact request, a configuration snapshot as `config.md`, and `progress.md` based on [the progress template](../assets/progress.md). Freeze selected validation commands and delivery preferences. Configure skill output destinations in the job context to use this job's spec, plan, and task list. If project instructions require their own artifact locations, record those pointers and keep one authoritative task list.

Stages are `spec`, `plan`, `build`, `verify`, `review`, `deliver`, `ready`, `blocked`, and `rejected`. A blocked record includes the interrupted stage, actual reason, and input or recovery needed. Save evidence before marking stages complete. Preserve feedback, failures, and review rounds chronologically.

## Execute

1. **Spec.** Apply `spec-driven-development`. Use `interview-me` or `idea-refine` when clarification is needed. Save scope and acceptance criteria. Obtain approvals required by applicable skills, counting explicit approvals already provided.
2. **Plan.** Apply `planning-and-task-breakdown`. Save dependencies, tasks, verification steps, and checkpoints. Use `constraint-driven-development` when the project needs an agreed quality bar. Resolve material open decisions before implementation.
3. **Build.** Apply `incremental-implementation`, `test-driven-development`, and `git-workflow-and-versioning`. Load relevant frontend, API, security, accessibility, or other specialists. Record completed tasks and commit IDs after each slice.
4. **Verify.** Run frozen checks in their recorded working directories and verify acceptance criteria. Save commands, exit results, commit, and relevant output. Apply `debugging-and-error-recovery` to failures, returning to build or recording a blocker. Missing tools and skipped checks cannot count as passes.
5. **Review.** Apply `code-review-and-quality` to the actual diff plus specialist reviews warranted by the changes. Save findings and resolutions. Code changes require affected checks and review to be refreshed for the new commit. Use the shared Definition of Done as the completion bar.
6. **Deliver.** Reconfirm remote identity, base branch, reviewed commit, checks, and delivery authorization. Push only the job branch and create or update its matching GitHub PR through the host's tools. Inspect existing branch PRs before creating another. Save its URL and head commit. Mark ready only when the PR head matches the checked and reviewed commit. Publication failures block at deliver with local evidence preserved. Report the ready PR for human review.

Apply `shipping-and-launch` when release preparation is requested. A normal job ends at its ready PR. Repeated recovery without new evidence stops with the actual blocker. Keep accepted scope through rework.

## Status, resume, and feedback

Status reads records, reports their timestamps and stages, links evidence and PRs, and flags absent checkouts. Repo-only status lists its jobs. Omitted repo lists all jobs. An ambiguous job ID requires its repo ID. Status starts no work and writes no records.

Resume reads the request, saved config, tasks, feedback, checks, and reviews. Reconcile checkout identity, branch/worktree, current HEAD, dirty files, recorded processes, and PR state. A live recorded process must finish before another attempt starts. Preserve unexpected edits and resolve ownership before continuing. Evidence for another commit is stale. Record discrepancies and refresh affected verification and review before delivery. Report manually merged PRs from actual GitHub evidence.

Feedback saves the person's exact words, timestamp, and blocked stage. Apply only what the answer resolves, then reconcile and resume. Configuration changes after creation affect the job only through an explicitly requested amendment saved in history.
