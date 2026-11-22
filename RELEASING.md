# Bootstrap release

## Verify locally

Run `npm test` using Node.js 22 or newer and Git. The suite packs the package, installs the tarball through npm offline, and checks generated skill references for Codex and Claude layouts. All fixture homes are temporary.

Create a distributable tarball with `npm pack`. To install it before publication, use its absolute path.

```sh
npm exec --yes --package=/absolute/path/create-command-center-0.2.0.tgz -- create-command-center ./my-home --agent both
```

Open a fresh Codex session and a fresh Claude Code session in the generated home. Confirm that `cc` and the engineering skills are listed. Exercise `cc init <repo-link>`, inspect its central config and ignored checkout, and repeat it to verify preservation. These live-agent discovery and registration checks complement the package tests.

## Prepare publication

Review `npm pack --dry-run --json`. The package allowlist includes the installer, clean home templates, the shared skill library, references, upstream license, and provenance. User repo configs, job history, checkouts, and tests are excluded.

The proposed npm name is `create-command-center`. Verify availability and npm account ownership before publishing. Original code uses the MIT license in `LICENSE`. The source repository is `https://github.com/rosstheboss94/command-center`. Preserve the upstream MIT notice in `LICENSE.agent-skills` separately.

Align package and plugin versions for a release. Refresh the bundled upstream tree and provenance only when intentionally changing its version. Review template changes, since the installer preserves conflicting files on repeat runs.

## Publish

Authenticate with the intended npm account, verify its identity and package rights, and obtain release authorization. Then run `npm publish --access public`. After publication, smoke-test `npx create-command-center@<version> <temporary-folder> --agent both` and verify the generated home in fresh agent sessions. The npm package has not been published.
