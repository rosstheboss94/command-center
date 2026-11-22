# Registration and central configuration

Run the bundled helper with Node.js 22 or newer and Git available. It discovers the home from canonical ancestors of the invocation directory and helper location. Explicit `--home` selects a home directly. Multiple candidates require a choice. Plugin caches are excluded from automatic discovery, including Codex and Claude plugin caches and Grok plugin caches and marketplace installs. Use the original valid home explicitly for a copied plugin. Existing bootstrap markers are accepted. Unmarked homes need a valid marker before discovery can use them.

## `cc init` procedure

1. Call `node <skill>/scripts/init.mjs prepare --cwd <invocation-directory> --source <repo-link-or-path>` with separate, quoted arguments. Use `--home` when selecting a specific home. Omit `--source` when the user omitted it. At the home root, an omitted source produces `SOURCE_REQUIRED`.
2. Read the returned home, version-2 report, structured facts, catalog, and inspection paths. Instruction scopes identify root and nested governing directories. Read only the instructions applicable to the work's directory, in ancestor order. A template instruction file governs its template directory. Keep the preparation report path.
3. Choose checks using explicit project instructions first, then CI commands, then documented manifest scripts. Record each command's working directory and exact source file. List unresolved conflicts and missing essentials as setup gaps. Registration does not execute checks.
4. Save a UTF-8 details JSON file in the home `.cc/` directory using the shape below. Populate purpose, relevant skill names, check proposals, and gaps from inspection. Existing chosen settings survive repeats.
5. Call `node <skill>/scripts/init.mjs register --home <returned-home> --report <report-path> --details <details-file>`. Read its exit code and JSON response. Report its `status`, identifiers, exact `changes`, effective `settings`, `setupGaps`, and `validationLimits` after success. Preparation changes and registration changes describe their respective operations.

```json
{
  "purpose": "Project purpose supported by its documentation",
  "checks": [
    { "command": "npm test", "workingDirectory": ".", "source": "AGENTS.md" }
  ],
  "skills": ["test-driven-development"],
  "setupGaps": []
}
```

Every check source must be in the inspection report. Working directories are relative to the checkout and must stay inside it. Supply empty arrays and explicit gaps when no checks or specialist skills are known. A missing purpose, missing checks, or unavailable default branch automatically creates a setup gap for a new record. The agent resolves command meaning and conflicts from project evidence. The helper validates structure and saves the result.

## Facts and validation

The helper reads data formats without executing project code. Structured facts cover Node package manifests and npm/pnpm/Yarn/Bun evidence, Python pyproject/Pipfile/requirements and uv/Poetry/Pipenv evidence, Go module/workspace declarations, and Rust package/workspace manifests. Workspace patterns are expanded against discovered projects with exclusions and repository boundaries. Each fact carries source evidence. Lockfiles marked `presence_only` establish their tool's presence without claiming their dependency contents were parsed. Unsupported or malformed manifests produce diagnostics and setup gaps.

Supported check structures include explicit Node script runners (`npm run`, `npm run-script`, `pnpm run`, `yarn run`, `bun run`), declared lifecycle aliases, Python declared entry points through `uv run`, `poetry run`, or `pipenv run`, basic `go test`, and Cargo check commands with the documented flags in the helper. Package scripts and Cargo package selections must exist in the relevant project/workspace. The selected manager must agree with confirmed declaration/lockfile evidence.

Successful structural resolution returns `verified_structure`. Custom commands, unsupported flags, external Python tools, and compound shell expressions return `unresolved_structure` with explicit limits and setup gaps. This status covers the command's declared structure. Check adequacy and runtime success require the job's actual verification stage.

Select skills from `catalog.skills`. Names must resolve to one valid canonical `home/skills/` entry. Discovery copies and user/project libraries do not add catalog entries. Missing or ambiguous selected skills produce `SKILL_INVALID`. Unselected malformed entries are returned as catalog diagnostics.

## Freshness and saved records

Preparation fingerprints instruction files, manifests, lockfiles, CI, documentation, and home skill entry points. Registration compares content and membership, then rederives facts from the current files. `INSPECTION_STALE` identifies changed paths and requires another preparation and agent inspection. Version-1 reports also require preparation again. Resolve parse, catalog, or command validation errors before retrying registration.

Configs retain editable Markdown settings and user notes. Generated Project facts, Instruction scope, and Check validation sections have `cc-init` ownership markers. The helper refreshes those sections and missing factual metadata while preserving existing chosen settings. Use `cc config` to amend those settings. Do not edit the preparation report to override facts.

Completion status is `created` for a new config, `repaired` for a changed existing config/index, and `reused` when both are unchanged. The compatibility `reused` boolean indicates that a config previously existed. Repeat-run results reflect saved settings and identify legacy validation prose that needs review.

## Fixed helper behavior

- Existing local paths take precedence over `owner/repo` shorthand. Remote inputs accept GitHub HTTPS root links, `git@github.com:owner/repo[.git]`, `ssh://git@github.com/owner/repo[.git]`, and `owner/repo`. Terminal `.git` and trailing slashes are removed for identity. Extra path segments, queries, fragments, other hosts, traversal, and credential-bearing URLs are rejected. The SSH user `git` is permitted.
- GitHub identities are lowercase `github.com/owner/repo`. New remote IDs are lowercase `owner--repo`, with `projects/<owner>/<repo>` checkouts. HTTPS links and shorthand clone through canonical HTTPS. SSH inputs clone through canonical SCP-style SSH. Git receives the argument array `clone`, `--`, URL, destination. Existing Git authentication applies.
- All central configs are searched before cloning. Missing identity metadata is derived from supported remote fields. Duplicate identities, malformed configs, and ID collisions stop the operation. Existing IDs, paths, and chosen settings are retained. Missing recorded checkouts require recovery.
- An existing destination must be its own Git top-level with a matching origin. A conflicting directory or origin is preserved and reported. Linked paths inside home cannot redirect a clone or registry write outside it.
- The helper ensures `/projects/` and `/.cc/` ignore rules are effective before cloning. Failed clones remain unregistered. Inspect any partial destination before retrying. Cleanup and relocation require an explicit recovery decision.
- Inspection resolves the primary checkout and common Git directory, origin, current branch, and default-branch evidence from `refs/remotes/origin/HEAD`. It lists project instructions, manifests, lockfiles, CI, and documentation in sorted order, skipping dependency and generated directories. It reads filenames and Git metadata. The agent reads the selected files to derive project meaning.
- New local registrations use lowercase checkout basenames with spaces replaced by hyphens. Local-only and non-GitHub-origin repositories match by their canonical primary checkout. Earlier local IDs for a GitHub identity are retained.
- Preparation reports live in `.cc/init/`. Registration rechecks checkout identity and scans configs again under an exclusive `.cc/init.lock`. It atomically writes config first, then adds one stable relative index link. Repeats repair missing factual metadata and missing links, preserving saved settings and index organization. An interrupted index write is repaired by repeating registration.

Both helper operations return JSON with `ok: true` on success. Errors return nonzero with `ok: false` and a redacted error. Stop at a helper refusal. A lock records its PID and start time. Inspect the owner and any Git child processes before recovering a stale lock. Never remove a lock owned by a live operation.

## Repos and config

`cc repos` reads the index and configs and reports paths and setup gaps. Inspection writes nothing. Above about 20 repos, group index links by purpose while retaining stable IDs.

`cc config <repo>` displays settings. A requested change updates only those settings. Commands resolve relative to the checkout, and skills relative to home. Changes affect future jobs. Existing jobs retain their saved config.

Central configuration owns factory settings. Project instructions apply in their repository. Inspect and report disagreements with central commands before claiming verification. Ask only for material choices that project evidence cannot settle.
