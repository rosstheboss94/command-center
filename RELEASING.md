# Bootstrap release

## Verify locally

Run `npm ci`, then `npm test` using Node.js 22 or newer and Git. The suite packs the package, installs its tarball through npm offline, and executes the bundled helper from Codex, Claude, and Grok copies. Fixture homes are temporary. Tests cover home resolution, evidence, workspaces, stale inputs, command/catalog validation, record preservation, completion results, and adding an agent to a `0.3.0` or current home.

The parser and workspace-glob dependencies are pinned as development dependencies and in `package-lock.json`. `npm run build:parsers` regenerates the checked-in helper bundle and notices. `npm pack` also runs this build through `prepack`. Generated homes use the bundle directly and need no dependency installation. Review bundle and notice changes alongside parser updates.

Create a distributable tarball with `npm pack`. To install it before publication, use its absolute path.

```sh
npm exec --yes --package=/absolute/path/create-command-center-0.4.0.tgz -- create-command-center ./my-home --agent all
```

Open a fresh Codex session, a fresh Claude Code session, and a fresh Grok Build session in the generated home. Confirm that `cc` and the engineering skills are listed. In Grok Build, run `grok inspect --json` and confirm those skills resolve to the home's `.grok/skills/` copies. `/cc` invokes the skill. Exercise `cc init <repo-link>`, inspect its central config and ignored checkout, and repeat it to verify preservation. These live-agent discovery and registration checks complement the package tests. Add Grok to an existing `0.3.0` home with `npx create-command-center@<version> . --add-agent grok`.

## Prepare publication

Review `npm pack --dry-run --json`. The package allowlist includes the installer, clean home templates, the shared skill library, references, upstream license, and provenance. User repo configs, job history, checkouts, and tests are excluded.

The npm package is `create-command-center`, owned by `rosstheboss94`. Confirm the npm account and package rights before publishing a new version. Original code uses the MIT license in `LICENSE`. The source repository is `https://github.com/rosstheboss94/command-center`. Preserve the upstream MIT notice in `LICENSE.agent-skills` separately.

Align package and plugin versions for a release. Refresh the bundled upstream tree and provenance only when intentionally changing its version. Review template changes, since the installer preserves conflicting files on repeat runs.

## Publish

Check `npm view create-command-center versions dist-tags --json` to confirm the current public versions before releasing. Each new version requires release authorization.

Authenticate with the intended npm account, verify its identity and package rights, and obtain release authorization. Then run `npm publish --access public`. Complete npm's publishing authentication and check the registry until the new version and dist-tag are visible. A staged placeholder or a successful command exit alone does not establish public availability. After publication, run `npx create-command-center@<version> . --agent all` from a fresh temporary folder and verify the generated home in fresh Codex, Claude Code, and Grok Build sessions.
