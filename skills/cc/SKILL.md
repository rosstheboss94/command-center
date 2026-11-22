---
name: cc
description: Initialize and operate a software factory home repo. Register project checkouts, maintain central configuration, and start, inspect, resume, or provide feedback on saved engineering jobs using the shared agent-skills workflows.
---

# Command Center

Interpret `cc` operations in chat using the host agent's normal tools. For init, the bundled helper discovers and validates the home marker from its location and the invocation directory. Use the returned home path for subsequent operations. If it reports ambiguous or missing homes, resolve that choice before proceeding. For copied plugins or legacy unmarked homes, select an explicit valid home through `--home`. Product changes belong in the target checkout's Git history.

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

For `cc init`, use the bundled Node helper at `scripts/init.mjs` for preparation and registration. Follow the helper contract in the registration reference. Inspect reported facts and scoped instructions, propose checks from project evidence, and select skills from its canonical home catalog. Use its completion status, effective settings, setup gaps, and validation limits when reporting the result.

Load relevant engineering skills from the home root's `skills/` on demand. Shared checklists live in the root `references/`. Read project instructions before operating there. User authorization takes precedence over skill defaults. Report conflicts that materially affect scope or checks.

Verify saved claims against files, commits, check results, and PR state. Resolve review findings and check failures before delivery. Preserve human decisions for merge and deployment.
