# Registration and central configuration

Resolve the home using the marker search in `SKILL.md`. On a copied plugin installation, resolve the original home path from the local marketplace source. If unavailable, ask for it. Save records in the actual home. Read its `AGENTS.md` to confirm the root.

## Init

`cc init` registers only the invocation's current project. An explicit link or path overrides it. In the home root, request a project link or path if none was supplied.

## Remote registration

Accept GitHub HTTPS repository links, SSH clone URLs (`git@github.com:owner/repo.git` or `ssh://git@github.com/owner/repo.git`), and `owner/repo` shorthand. An existing local path takes precedence over shorthand. Normalize GitHub identities to owner/repo without a trailing `.git`, comparing case-insensitively. Accept only a repository root link. Ask for clarification for branch, file, or other host URLs. Reject embedded passwords or tokens and request a clean URL. Use existing Git or GitHub CLI authentication.

Look for the normalized identity in all existing records before cloning. Reuse its existing ID and preserve its chosen settings. New remote registrations use lowercase `owner--repo` IDs and checkout paths `projects/<owner>/<repo>` relative to home. Validate owner and repo as single directory components, excluding `.` and `..`, separators, and traversal. Confirm the final destination stays inside home `projects/`. Ensure `/projects/` is in the home `.gitignore` before cloning.

If the destination exists, verify that it is a Git checkout with a matching origin. Reuse a matching checkout. A mismatched origin or non-checkout directory is a collision requiring a path decision. Preserve existing contents and user edits.

Clone with the host's Git tools using separate, quoted arguments (`git clone -- <clean-url> <destination>`), or GitHub CLI with the same destination. Use standard authentication and record the command's actual outcome. If cloning fails, leave the repo unregistered, report the error, and inspect any partially created destination before retrying. Remove only a demonstrably owned empty or failed-clone directory when safe, otherwise retain it for recovery. A failure never permits replacing an existing checkout.

After cloning, follow local inspection and central configuration below. A successful checkout with unresolved project settings can be registered with explicit setup gaps. Save the config before adding its index link. On interruption, inspect both before retrying and repair a missing index entry without replacing settings. Repeat registration creates no additional clone or record.

## Local inspection and records

Resolve the Git top level and common Git directory, supporting subdirectories and linked worktrees. Record the primary checkout. Inspect the remote, default branch, instructions, manifests, and CI. Remove embedded credentials from the remote before recording it. Avoid secret files. Missing default-branch evidence requires input.

For a new local registration, use a lowercase repository basename as the ID, replacing spaces with hyphens. Preserve existing IDs, including earlier local registrations of the same remote. The same primary checkout updates only discovered path metadata and preserves chosen settings. A conflicting ID or multiple checkouts with the same remote requires a distinct user-selected ID or path decision.

Create `repos/<id>/config.md` from [the config template](../assets/config.md). Store checkout paths relative to the home root. Record purpose, remote identity, base branch, instruction paths, validation commands with working directories, applicable skills, and delivery preferences. Import useful existing settings as data. Keep checks as command instructions in Markdown. Mark unknown essentials as needing setup with the exact missing information.

Derive meaningful checks from project docs, manifests, and CI. A job with unresolved essential checks stays blocked until suitable checks or a user decision resolve them. Registration itself does not run checks.

Update `repos/index.md` with a pointer to each config. Above about 20 repos, group links by purpose while retaining stable IDs. Keep root `AGENTS.md` pointing to this index. Preserve existing content on repeats and interrupted writes. Initialization updates the home registry. It does not edit child project instructions or copy shared skills into each project.

## Repos and config

`cc repos` reads the index and configs, reporting missing or moved checkouts and setup gaps. Inspection writes nothing.

`cc config <repo>` displays settings. A requested change updates only those settings. Resolve commands relative to the target checkout and skill paths relative to home. Changes affect future jobs. Existing jobs retain their saved configuration.

Central configuration owns factory settings. Project instructions apply to work in that repo. If instructions and central commands disagree, inspect current evidence, report the discrepancy, and resolve it before claiming verification. Ask only for material choices that project evidence cannot settle.
