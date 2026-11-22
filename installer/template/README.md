# Command Center

Open Codex or Claude Code in this folder and select the `cc` skill. Then request `cc init https://github.com/owner/project` in chat. The agent clones it into `projects/owner/project` and saves central settings under `repos/`.

Use `cc repos`, `cc config <repo>`, `cc start <repo> <task>`, `cc status`, `cc resume <repo> <job>`, and `cc feedback <repo> <job> <text>` in chat. See `skills/cc/SKILL.md` for the workflow.

Starting a job authorizes job-branch commits, pushes, and a ready PR after checks and review. Skills honor existing approvals and require evidence for completion. Merge and deployment remain human decisions.

Shared skills come from the commit in `UPSTREAM.md`, with licensing in `LICENSE.agent-skills`. Central configuration and job records are versionable. Project checkouts have their own history.

The agent discovery copies are generated from the canonical `skills/` and `references/` trees. Keep these copies synchronized when editing skills. The bootstrap preserves differing files and reports conflicts on repeat installation.
