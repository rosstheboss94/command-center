# Software Factory Command Center

This is a skills-only home repo. The user-facing `cc` skill is `skills/cc/SKILL.md`. Start your coding agent here and invoke `cc` to initialize repo pointers or coordinate software work using the shared agent skills.

The 26 upstream engineering skills and shared references are preserved from the commit recorded in [UPSTREAM.md](UPSTREAM.md). Central project configurations live under `repos/`. Job requests, config snapshots, progress, checks, reviews, and feedback live under `jobs/`. Product source remains in its own checkout.

## Install a home repo

The npm package is prepared locally and awaits publication. After release, users can run the following in a new folder with Node.js 22 or newer and Git installed.

```sh
mkdir my-command-center
cd my-command-center
npx create-command-center@latest .
```

Choose Codex, Claude Code, or both. For a non-interactive install, pass `--agent codex`, `--agent claude`, or `--agent both`. An explicit destination path can replace `.`.

The bootstrap copies a versioned home template, canonical skills, shared references, and project-local discovery copies for the selected agents. It initializes Git, ignores `projects/`, and writes `.command-center.json` so the skill can find the home root. The generated home contains the skill workflows and records. The installer source and tests stay in this distribution repository.

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
| `cc status [repo] [job]` | Inspect saved progress and evidence |
| `cc resume <repo> <job>` | Reconcile and continue an interrupted job |
| `cc feedback <repo> <job> <text>` | Record an answer and continue |

Start authorizes job branch commits, pushes, and PR creation after checks and review. The workflows follow the upstream skills' approval checkpoints and honor approvals already given. Merge and deployment remain human decisions. These operations are performed by the coding agent through skill instructions. Progress and checks must be backed by recorded evidence.

No projects are enrolled automatically. Register the projects you want through `cc init`. Skills may include upstream bundled helpers for their specialized tasks, as documented in `UPSTREAM.md`.

Original Command Center code is licensed under [MIT](LICENSE). The upstream skills retain their [MIT license notice](LICENSE.agent-skills).
