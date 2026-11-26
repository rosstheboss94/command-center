import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomic, hash } from '../skills/ready/cc/scripts/factory/io.mjs';
import { verifySource, resolveRef, claimDestination, verifyArtifact, transferConfiguration } from '../skills/ready/cc/scripts/update/prepare.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-prepare-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'old'), checkout = join(root, 'checkout');
  await mkdir(join(home, 'repos/stable-id'), { recursive: true }); await mkdir(checkout);
  execFileSync('git', ['init', checkout], { stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/rosstheboss94/command-center.git'], { cwd: checkout });
  const markdown = `# Stable\n\n## Repository\n\n- Purpose — My factory\n- Checkout — ${checkout}\n- Remote — https://github.com/rosstheboss94/command-center.git\n- Repository identity — github.com/rosstheboss94/command-center\n- Base branch — main\n\n## Validation\n\n- Command — npm test\n  Working directory — .\n  Source — package.json\n\n## Setup gaps\n\nNone.\n\n## Engineering skills\n\ntest-driven-development\n\n## Delivery\n\nMy custom delivery policy.\n`;
  await writeFile(join(home, 'repos/stable-id/config.md'), markdown);
  return { root, home, checkout, markdown };
}
test('source selection verifies registered GitHub identity and refuses changed remotes', async t => {
  const { home, checkout } = await fixture(t);
  const source = await verifySource(home, async () => ({ code: 0, stdout: JSON.stringify({ nameWithOwner: 'rosstheboss94/command-center' }) }));
  assert.equal(source.repo, 'stable-id');
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/other/command-center.git'], { cwd: checkout });
  await assert.rejects(verifySource(home), /identity/);
});
test('refs resolve to immutable commits; options and unverified output cannot pin source', async () => {
  const calls = [], sha = 'a'.repeat(40);
  const run = async (file, args) => { calls.push(args); return { code: 0, stdout: args[0] === 'rev-parse' ? sha : '' }; };
  assert.equal(await resolveRef('/source', 'main', run), sha);
  assert.deepEqual(calls[0], ['fetch', '--no-tags', 'origin', 'main']);
  await assert.rejects(resolveRef('/source', '--upload-pack=evil', run), /ref/);
  await assert.rejects(resolveRef('/source', 'main', async () => ({ code: 0, stdout: 'main' })), /commit/);
});
test('destination claiming is resumable only for the same journal and never replaces unrelated files', async t => {
  const { root } = await fixture(t), destination = join(root, 'new');
  await mkdir(destination); await writeFile(join(destination, 'custom.txt'), 'keep');
  await assert.rejects(claimDestination(destination, 'id', 'nonce'), /destination|Destination/);
  assert.equal(await readFile(join(destination, 'custom.txt'), 'utf8'), 'keep');
  const other = join(root, 'other'); await claimDestination(other, 'id', 'nonce'); await claimDestination(other, 'id', 'nonce');
  await assert.rejects(claimDestination(other, 'id', 'different'), /destination|Destination/);
});
test('artifact bytes must match their recorded digest', async t => {
  const { root } = await fixture(t), artifact = join(root, 'package.tgz');
  await writeFile(artifact, 'package'); await verifyArtifact(artifact, hash('package'));
  await writeFile(artifact, 'changed'); await assert.rejects(verifyArtifact(artifact, hash('package')), /digest/);
});
test('configuration transfer preserves stable IDs, purpose, checks and providers with refreshed fingerprints', async t => {
  const { root, home, markdown } = await fixture(t), destination = join(root, 'new'), checkout = join(destination, 'projects/rosstheboss94/command-center');
  await mkdir(checkout, { recursive: true }); await mkdir(join(destination, 'repos'), { recursive: true });
  const settings = { blocking: false, concurrency: 3, roles: { builder: { runner: 'grok', model: null } } };
  await atomic(join(home, 'repos/stable-id/factory.json'), { schemaVersion: 1, markdownHash: hash(markdown), settings });
  await transferConfiguration(home, destination, { repo: 'stable-id', checkout }, { refresh: async () => {}, save: async (h, id, value) => {
    await atomic(join(h, 'repos', id, 'factory.json'), { schemaVersion: 1, markdownHash: hash(await readFile(join(h, 'repos', id, 'config.md'))), settings: value });
  } });
  const config = await readFile(join(destination, 'repos/stable-id/config.md'), 'utf8');
  assert.match(config, /My factory/); assert.match(config, /npm test/); assert.match(config, /My custom delivery policy/);
  assert.match(config, /projects\/rosstheboss94\/command-center/);
  const saved = JSON.parse(await readFile(join(destination, 'repos/stable-id/factory.json')));
  assert.deepEqual(saved.settings, settings); assert.equal(saved.markdownHash, hash(config));
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'repos/factory.json'))), { concurrency: 3 });
});
