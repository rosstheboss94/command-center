---
name: cc
description: Initialize and operate Command Center's enforced software factory. Register projects, queue GitHub issues, run configurable Codex/Claude/Grok roles with isolated worktrees and evidence gates, and resume jobs through ready pull requests.
---

# Command Center

Interpret `cc` operations in chat using the host agent's normal tools. For init, the bundled helper discovers and validates the home marker from its location and the invocation directory. Use the returned home path for subsequent operations. If it reports ambiguous or missing homes, resolve that choice before proceeding. For copied plugins or legacy unmarked homes, select an explicit valid home through `--home`. Product changes belong in the target checkout's Git history.

| Request | Action |
| --- | --- |
| `cc init [repo-link-or-path]` | Clone and register a remote, or register a local checkout |
| `cc repos` | List registered repos, paths, and setup gaps |
| `cc config <repo> [change]` | Read configuration, or apply the requested change |
| `cc start <repo> <task>` | Save the request and carry the job through the engineering workflow |
| `cc add <repo> <idea>` | Create a queued GitHub issue without starting work |
| `cc run <repo> [issue]` | Process an issue snapshot with bounded concurrent jobs |
| `cc config <repo> factory` | Inspect or configure factory runners, models, timeouts, and limits |
| `cc status [repo] [job]` | Read saved stages, evidence, blockers, and PR links |
| `cc resume <repo> <job>` | Reconcile and continue the saved job |
| `cc feedback <repo> <job> <text>` | Save the person's answer and continue the affected stage. A reply whose text is exactly `a`, `b`, or `c` records that restart option and continues the same job from the interrupted stage |
| `cc adopt <repo> <job>` | Preserve and validate a legacy job before refreshing evidence |

Read [registration](references/registration.md) for init, repos, and project config. Read [jobs](references/jobs.md) for factory configuration, issue queues, start, status, resume, adoption, and feedback. Use bundled `scripts/factory.mjs` for factory operations, never a separately installed factory skill or direct state edits. A bare invocation describes operations without writing records.

For `cc init`, use the bundled Node helper at `scripts/init.mjs` for preparation and registration. Follow the helper contract in the registration reference. Inspect reported facts and scoped instructions, propose checks from project evidence, and select skills from its canonical home catalog. Use its completion status, effective settings, setup gaps, and validation limits when reporting the result.

Load relevant engineering skills from the home root's `skills/` on demand. Shared checklists live in the root `references/`. Read project instructions before operating there. User authorization takes precedence over skill defaults. Report conflicts that materially affect scope or checks.

Verify saved claims against files, commits, check results, and PR state. Resolve review findings and check failures before delivery. Preserve human decisions for merge and deployment.
