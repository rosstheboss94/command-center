# Workflow-owned skills

Canonical content lives at `skills/<workflow-step>/<skill>/SKILL.md`. Each name has one owner:

| Owner | Skills |
| --- | --- |
| intake | interview-me, idea-refine |
| spec | spec-driven-development, constraint-driven-development |
| plan | planning-and-task-breakdown |
| build | incremental-implementation, frontend-ui-engineering, api-and-interface-design, code-simplification, observability-and-instrumentation |
| verify | test-driven-development, browser-testing-with-devtools, debugging-and-error-recovery |
| review | code-review-and-quality, security-and-hardening, performance-optimization, accessibility-engineering |
| approve | doubt-driven-development |
| deliver | git-workflow-and-versioning, ci-cd-and-automation, deprecation-and-migration, documentation-and-adrs, shipping-and-launch |
| ready | cc, using-agent-skills, context-engineering, source-driven-development |

Ownership identifies where guidance is maintained. Cross-cutting availability is separate. The public entrypoint is [cc](../SKILL.md), using its bundled `scripts/init.mjs` and `scripts/factory.mjs`. No separately installed factory skill is required. Public cc commands retain their names.

## Factory selection

Every agent role receives using-agent-skills, context-engineering, and source-driven-development, plus the following:

| Role | Additional guidance |
| --- | --- |
| intake | interview-me, idea-refine |
| spec | spec-driven-development, constraint-driven-development, api-and-interface-design, deprecation-and-migration, security-and-hardening |
| plan | planning-and-task-breakdown, incremental-implementation, test-driven-development |
| builder | all build-owned and verify-owned skills, security-and-hardening, accessibility-engineering, performance-optimization, git-workflow-and-versioning, ci-cd-and-automation, deprecation-and-migration, documentation-and-adrs, doubt-driven-development |
| review-code | code-review-and-quality, code-simplification, test-driven-development, api-and-interface-design |
| review-security | security-and-hardening, code-review-and-quality |
| review-ui | frontend-ui-engineering, accessibility-engineering, browser-testing-with-devtools |
| review-ux | accessibility-engineering, frontend-ui-engineering, code-review-and-quality |
| approver | doubt-driven-development, code-review-and-quality, shipping-and-launch |

Explicit saved project selections are validated and added by stable name to each role's subset. Ambiguous names cannot be selected. cc is discoverable to hosts but is only added to factory subsets when explicitly selected. A skill cannot expand the role's permissions or authorize another factory run.

Selection occurs at the role boundary for provider prompts and injected runners. It limits the catalog advertised by the helper. It does not remove globally installed skills, control a host's automatic skill discovery, or provide a security sandbox. Verify, deliver, and ready remain helper stages; this layout adds no agent dispatch and does not enable disabled reviews.

Blocked and rejected are recovery states with no canonical skill directories. Resumption uses the validated interrupted role and adds debugging-and-error-recovery guidance. Invalid recovery state is diagnosed. Rejected work stays rejected under the existing restart rules.

## Host discovery and reproducibility

Codex receives `.agents/skills/<name>`, Claude receives `.claude/skills/<name>`, and Grok receives `.grok/skills/<name>`. Fresh bundled homes have 27 flat skills in each selected host's tree, with references alongside at `<host>/references`. Projection rewrites resolving relative references and preserves scripts, assets, and notices. Canonical content is the editable source.

The repository plugin uses the generated flat `discovery/skills/` projection. Run `node installer/build-discovery.mjs` to regenerate it after canonical changes; `node installer/build-discovery.mjs --check` diagnoses drift without modifying files. Directory nesting does not rely on recursive host discovery. Filesystem and CLI tests validate shipped layouts and helpers; they do not establish discovery behavior in a real host session.

## Existing homes and explicit migration

Complete, unambiguous flat homes remain readable. Normal installation and add-agent do not silently relocate them. Saved skill names remain stable; current registration paths and digests refresh only through explicit registration/configuration. Historical jobs and frozen reports retain their recorded paths and hashes.

Preview a supported flat home without writes:

```sh
node bin/create-command-center.mjs /path/to/home --migrate-skills
```

Apply after inspecting the listed paths and conflicts:

```sh
node bin/create-command-center.mjs /path/to/home --migrate-skills --apply
```

Migration cannot be combined with install/add-agent flags. Automated V1 migration supports exact managed skill, shared reference, marker, and selected discovery bytes from published 0.3.0 and 0.4.0 releases. Inventories are pinned to those archives; code in the destination is never executed. Unrelated files and edited scaffold/configuration records are retained. Unknown versions, missing files, customization, duplicate names, mixed layouts, linked paths, or conflicting destinations block preflight with paths. Active runners and nonterminal jobs also block migration and identify their records.

Keep a complete independent backup before migration. The installer also saves every replaced managed file under `.skill-migration-backup/` and records operations in `.skill-migration.json`, outside job records. Completion is written last. Repeating a completed apply makes no changes. An incomplete journal blocks normal helper dispatch. Re-run the same installer with `--migrate-skills --apply` to resume after hash validation. Unexpected current files, changed backups, or an invalid journal stop recovery. If interrupted during backup preparation before the journal exists, no managed files have been promoted: preserve and inspect the backup directory, move it aside, then retry.

For customization or unsupported layouts, retain the original complete home, create a fresh sibling home, and reconcile customized skills and references explicitly into their owned locations. Validate its catalog and canonical/copied helpers, then re-register projects. Finish active jobs with their original home/version, or preserve their records and start successor work in the sibling home using the original request and a prior-job reference. Do not copy old checks or approvals as current evidence. Archived jobs remain inspectable; resumption requiring missing frozen skill paths fails with this recovery route.
