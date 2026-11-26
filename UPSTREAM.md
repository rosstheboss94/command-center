# Upstream skills

Source — https://github.com/addyosmani/agent-skills

Commit — `8c99fa36d90068c82d547f7c12a9d67a3e95f4ee`

The 26 upstream skills are maintained under `skills/<workflow-step>/<skill>/` and shared checklists under `references/`. Their content originates from that commit; local relative references and workflow discovery guidance are adjusted for this layout. These adjusted files are not byte-for-byte upstream copies. Their license is `LICENSE.agent-skills`. The `cc` skill at `skills/ready/cc/` is maintained here. Flat files under `discovery/` are generated projections of canonical sources, retaining their notices.

Upstream skill folders include three bundled helpers used by their own guidance. These remain part of the upstream skills. Command Center's workflows and saved records are Markdown and require the host agent's existing tools.

To update, review a selected upstream commit, replace its skill folders and shared references together, preserve the local `cc` skill, update this provenance and license, and validate references and discovery before using the new version.

The local `cc` helper also bundles `smol-toml`, `yaml`, and `picomatch` for declarative project parsing and workspace expansion. Exact versions are pinned in the distribution's package files. Rebuild with `npm run build:parsers`. Their license notices ship beside the generated parser bundle in the skill's `scripts/vendor/` directory.
