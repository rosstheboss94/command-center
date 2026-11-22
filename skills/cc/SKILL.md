---
name: cc
description: Initialize and operate a software factory home repo. Register project checkouts, maintain central configuration, and start, inspect, resume, or provide feedback on saved engineering jobs using the shared agent-skills workflows.
---

# Command Center

Interpret `cc` operations in chat using the host agent's normal tools. Locate the home by walking upward from the installed skill directory to `.command-center.json`. This works for the canonical skill and the project-local Codex and Claude copies. For an existing plugin installation, resolve its original home from the marketplace source instead of its cache. The source checkout can be identified by its root `AGENTS.md`, `repos/`, and `skills/cc/`. If the home is unresolved, ask for its path before writing records. Resolve projects from that home registry. Product changes belong in the target checkout's Git history.

| Request | Action |
| --- | --- |
| `cc init [repo-link-or-path]` | Clone and register a remote, or register a local checkout |
| `cc repos` | List registered repos, paths, and setup gaps |
| `cc config <repo> [change]` | Read configuration, or apply the requested change |
| `cc start <repo> <task>` | Save the request and carry the job through the engineering workflow |
| `cc status [repo] [job]` | Read saved stages, evidence, blockers, and PR links |
| `cc resume <repo> <job>` | Reconcile and continue the saved job |
| `cc feedback <repo> <job> <text>` | Save the person's answer and continue the affected stage |

Read [registration](references/registration.md) for init, repos, and config. Read [jobs](references/jobs.md) for start, status, resume, and feedback. A bare invocation describes operations without writing records.

Load relevant engineering skills from the home root's `skills/` on demand. Shared checklists live in the root `references/`. Read project instructions before operating there. User authorization takes precedence over skill defaults. Report conflicts that materially affect scope or checks.

Verify saved claims against files, commits, check results, and PR state. Resolve review findings and check failures before delivery. Preserve human decisions for merge and deployment.
