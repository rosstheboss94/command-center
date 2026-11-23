# Command Center

Open Codex, Claude Code, or Grok Build in this folder and invoke the `cc` skill. In Grok Build, use `/cc`. Then request `cc init https://github.com/owner/project` in chat. The agent clones it into `projects/owner/project` and saves central settings under `repos/`.

Init uses the skill's bundled Node helper for home discovery, URL validation, identity matching, cloning, facts, scopes, freshness checks, and atomic config/index writes. It validates selected home skills and supported check structures. The agent chooses checks from project instructions first, then CI, then documented manifest scripts. Missing essentials and custom-command limits become setup gaps. Repeat init preserves settings and returns an exact created, reused, or repaired summary. Temporary reports and locks live in the ignored `.cc/` directory.

Use `cc repos`, `cc config <repo>`, `cc start <repo> <task>`, `cc status`, `cc resume <repo> <job>`, and `cc feedback <repo> <job> <text>` in chat. See `skills/ready/cc/SKILL.md` for the workflow.

Starting a job authorizes job-branch commits, pushes, and a ready PR after checks and review. Skills honor existing approvals and require evidence for completion. Merge and deployment remain human decisions.

Shared skills come from the commit in `UPSTREAM.md`, with licensing in `LICENSE.agent-skills`. Central configuration and job records are versionable. Project checkouts have their own history.

Canonical skills use `skills/<workflow-step>/<skill>/`. Agent discovery copies use flat named directories: `.agents/skills/<skill>/`, `.claude/skills/<skill>/`, and `.grok/skills/<skill>/`, with shared references alongside. Grok also reads `AGENTS.md`. The installer projects references for each location and preserves differing files. Directory nesting does not isolate globally installed skills. Use explicit `--migrate-skills` preview and `--migrate-skills --apply` for unmodified published 0.3.0/0.4.0 flat homes; active jobs or customized managed files block migration. Keep the original home to finish old jobs, or reconcile customizations into a fresh sibling home and re-register projects. Frozen evidence is never rewritten.
