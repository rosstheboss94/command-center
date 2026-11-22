# Software Factory Command Center

This is a software factory home repo with a bundled Node.js runtime. The user-facing `cc` skill is `skills/cc/SKILL.md`. Start your coding agent here and invoke `cc` to register projects or coordinate software work using the shared agent skills.

The 26 upstream engineering skills and shared references are preserved from the commit recorded in [UPSTREAM.md](UPSTREAM.md). Central project configurations live under `repos/`. Job requests, config snapshots, progress, checks, reviews, and feedback live under `jobs/`. Product source remains in its own checkout.

## Install a home repo

Version `0.4.0` adds Grok Build as a host for the same skills and workflows. Version `0.3.0` added the deterministic init helper described below. Install the latest published release in a new folder with Node.js 22 or newer and Git installed.

```sh
mkdir my-command-center
cd my-command-center
npx create-command-center@latest .
```

Choose Codex, Claude Code, Grok Build, both, or all. `both` installs Codex and Claude Code and remains the interactive default. `all` installs all three. For a non-interactive install, pass `--agent codex`, `--agent claude`, `--agent grok`, `--agent both`, or `--agent all`. An explicit destination path can replace `.`.

The bootstrap copies a versioned home template, canonical skills, shared references, and project-local discovery copies for the selected agents. Codex uses `.agents/`, Claude Code uses `.claude/`, and Grok Build uses `.grok/skills/` plus `.grok/references/`. It initializes Git, ignores `projects/`, and writes `.command-center.json` so the skill can find the home root. The generated home contains the skill workflows and records. The installer source and tests stay in this distribution repository.

Grok Build reads the home `AGENTS.md` and discovers the installed skills from `.grok/skills/`. Invoke `/cc` in a Grok session opened in that home.

To add one agent to an existing home from `0.3.0` or this release, without upgrading the rest of the home:

```sh
npx create-command-center@latest . --add-agent grok
```

`--add-agent` accepts `codex`, `claude`, or `grok`. It copies that home's canonical `skills/` and `references/` into the agent's discovery directories, so home-specific skill edits are kept. It updates the home validator where the installed copy still matches the `0.3.0` baseline, records the agent in the existing marker, and keeps the home's template version. Repeat the command after it succeeds and it makes no further changes. Combine it with `--agent` and the command stops before writing.

Open a fresh agent session in the generated home and select the `cc` skill. Ask `cc init https://github.com/owner/project` in chat. The agent clones into `projects/owner/project` and registers the project centrally. GitHub SSH clone URLs, `owner/repo` shorthand, and local paths are also supported.

Identical files are preserved on repeat installation and missing files are restored. Changed managed files are reported before writing anything. Configured settings and job records remain in place. Upgrades involving changed templates require review of those conflicts.

For local development and tarball installation before npm publication, see [release instructions](RELEASING.md). The existing Codex plugin metadata remains available for plugin-based installations.

## Operations

| Request in chat | Result |
| --- | --- |
| `cc init [repo-link-or-path]` | Clone a remote project or register a local checkout |
| `cc repos` | List repo pointers and setup gaps |
| `cc config <repo> [change]` | Inspect or update central settings |
| `cc start <repo> <task>` | Spec, plan, build, verify, review, and prepare a PR |
| `cc add <repo> <idea>` | Queue a GitHub issue without starting work |
| `cc run <repo> [issue]` | Process a snapshot of queued issues or one selected issue |
| `cc config <repo> factory` | Configure per-role Codex/Claude/Grok runners and limits |
| `cc adopt <repo> <job>` | Preserve and validate a legacy job for the enforced workflow |
| `cc status [repo] [job]` | Inspect saved progress and evidence |
| `cc resume <repo> <job>` | Reconcile and continue an interrupted job |
| `cc feedback <repo> <job> <text>` | Record an answer and continue |

Start authorizes job branch commits, pushes, and PR creation after checks and review. The workflows honor approvals already given. Merge and deployment remain human decisions. The invoking agent routes factory operations through the bundled helper. Progress and checks must be backed by recorded evidence.

The bundled factory helper owns job state, isolated worktrees, process logs, frozen checks, independent role reviews, and exact-commit PR delivery. Defaults are three concurrent jobs per repository, three rework rounds, and 30 minutes per role or check. Roles use the invoking host's CLI and default model unless configured otherwise. Missing CLIs or permissions block work without switching providers. GitHub queues use `cc:queued`; newly arriving issues wait for the next run. The workflow has no dependency on a separately installed factory skill. See [factory operations and recovery](skills/cc/references/jobs.md) for the helper contract and configuration.

The factory implementation in this checkout is unreleased; installing public `0.4.0` does not include these new job helpers. Test this checkout's tarball using the release instructions. No existing customized home is overwritten automatically.

No projects are enrolled automatically. Register the projects you want through `cc init`. Skills may include upstream bundled helpers for their specialized tasks, as documented in `UPSTREAM.md`.

## Deterministic init in 0.3.0

The `cc` skill calls its bundled Node helper to validate and normalize input, search saved configs, resolve a checkout, and prepare a version-2 inspection report. The agent reads the reported project files and proposes checks using project instructions first, then CI, then documented manifest scripts. Unknown essentials become setup gaps.

| Area | Helper behavior |
| --- | --- |
| Home discovery | Validates home markers, resolves canonical paths, and reports ambiguous choices |
| Project facts | Parses Node, Python, Go, and Rust declarations with source evidence and workspace membership |
| Freshness | Fingerprints inspected inputs and the home skill catalog, rejecting changed inputs before registration |
| Checks | Verifies supported script and native-command structures and records limits for custom commands |
| Instructions | Records each instruction file's governing directory and applicable ancestor order |
| Skills | Validates selected names against canonical home skill entries |
| Completion | Returns created, reused, or repaired with changed paths, effective settings, and setup gaps |

The helper then revalidates the checkout, saves config atomically, and adds its stable index link. Repeating init preserves chosen settings and repairs missing factual metadata or a missing index link. Collisions and clone failures stop registration with existing contents preserved. Preparation reports and process locks live in the ignored `.cc/` directory.

Generated facts, instruction scopes, and structural check results are saved in marked Markdown sections. Custom commands remain available with explicit validation limits. Project-specific meaning and actual runtime verification belong to the agent's engineering workflow.

The helper contract and structured details format are documented in [registration](skills/cc/references/registration.md). It is used by the skill through chat. Temporary helper reports and locks are separate from the versionable repo configs and job records.

Original Command Center code is licensed under [MIT](LICENSE). The upstream skills retain their [MIT license notice](LICENSE.agent-skills).
