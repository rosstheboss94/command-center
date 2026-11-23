# Verified published release inputs

Restricted role processes do not need npm registry access to inspect legacy migration baselines. Command Center ships complete inventories for `create-command-center` 0.3.0 and 0.4.0 under `assets/release-baselines/` inside the cc skill. Each inventory is derived from the exact published tarball, verified against the npm SHA-512 integrity value recorded in `pins.json`. The inventory itself has a pinned SHA-256 hash. No destination code is executed to establish a baseline.

## Inventory contract

Each versioned JSON file contains:

- `package`: package name, version, and pinned npm integrity, archive URL, and file count.
- `metadataURL`: the official registry URL used to establish the pin.
- `packageFiles`: every regular published package file, with SHA-256 and byte size.
- `managedFiles`: the generated home files with SHA-256, size, source package path where applicable, and group. Discovery-copy entries have an `agent` condition (`codex`, `claude`, or `grok`). `CLAUDE.md` is generated rather than copied.
- `markers`: `.command-center.json` hashes for each sorted agent combination, including `none` for an empty agents array. The marker is generated from the version, schema version 1, and selected agents.

The inventories describe exact old release bytes. They do not establish that an installed home is unmodified. A migration must still compare actual files, preserve customization and unrelated files, respect the selected agent conditions, and treat mutable project/job records separately. `template` entries describe the original scaffold; they do not authorize overwriting edited configuration or records.

The 0.3.0 package has 67 regular files and 170 managed entries across its conditional projections; 0.4.0 has 68 and 224. Host selections must filter conditional entries. The package archives are not bundled, and no release has been republished.

## Host prefetch and local import

Use the host's existing permissions to cache original archives when a job also needs release file contents:

```sh
node <cc-skill>/scripts/factory.mjs release-inputs --home <home>
```

This reads the two fixed public npm metadata endpoints, compares them to the shipped pins, verifies each downloaded archive, derives and compares its inventory, and writes an atomic cache under `.cc/factory/release-inputs/<version>/`. Each cache contains `package.tgz`, normalized `metadata.json`, `inventory.json`, and a verification receipt. Downloads and decompression are bounded. Links, duplicate/unsafe archive paths, unsupported tar entry types, wrong versions, and integrity mismatches are rejected. The parser inventories regular files without extracting or executing them.

For an environment without registry access, provide a directory containing `create-command-center-0.3.0.tgz` and `create-command-center-0.4.0.tgz`:

```sh
node <cc-skill>/scripts/factory.mjs release-inputs --home <home> --from <directory> --offline
```

Optional `0.3.0.metadata.json` and `0.4.0.metadata.json` files must agree with the shipped pins. Supplied metadata cannot redefine trusted integrity values. To validate and reuse a complete existing cache without network access, omit `--from` and use `--offline`. A partial or corrupt cache fails with the affected version and recovery action; replace it using verified local inputs with `--from`. No credentials are written, providers changed, or sandbox restrictions disabled.

## Existing job recovery

On each role dispatch the host verifies the bundled inventories and any available archive receipts, supplies their absolute paths and provenance in the prompt, and saves the descriptors as `release-inputs.json` beside the job reports. This is environment evidence, not a change to frozen task scope, configuration, or earlier reports. Jobs created before this capability can receive it on resume without rewriting `context.json`.

After fixing an operational input failure, update the clean job worktree from its configured base and use the normal resume operation. The helper records changed HEAD and invalidates stale verification/approval evidence. A genuine NEEDS_INFO/BLOCKED decision still requires the person's response through feedback. Never manufacture a passing report, reset limits, duplicate an issue job, or edit state directly to recover it.
