# Command Center

This folder is the software factory home repo. Its `.command-center.json` marker identifies the home root. Use the `cc` skill to register repositories and run engineering jobs.

Shared skills live in `skills/` and their checklists in `references/`. Discoverable copies for the selected agents are installed in their project-local skill directories. Load guidance on demand.

See [registered repositories](repos/index.md). Central configuration lives under `repos/`, saved job records under `jobs/`, and cloned projects under the gitignored `projects/`. Resolve checkout paths relative to this home. Read each target project's instructions before working in it.

Save exact requests, configuration snapshots, progress, and evidence in the home job records so another session can resume. Product changes belong in the target project's own Git history.
