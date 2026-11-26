import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './factory-fixture.mjs';
import { execute, git, json } from '../skills/ready/cc/scripts/factory/io.mjs';
import { prepareUpdate, sourceURL } from '../skills/ready/cc/scripts/update/prepare.mjs';
import { updateStatus, assertActive } from '../skills/ready/cc/scripts/update/state.mjs';
import { tree } from '../skills/ready/cc/scripts/update/inventory.mjs';

test('real pinned build, packed install, failed-step recovery and duplicate preparation preserve the old home', { timeout: 180000 }, async t => {
  const f = await fixture(t, { github: sourceURL, blocking: false });
  for (const path of ['installer', 'skills', 'references', 'discovery', 'bin', '.codex-plugin', 'LICENSE', 'LICENSE.agent-skills', 'UPSTREAM.md', 'RELEASING.md', '.gitignore', 'package.json', 'package-lock.json']) {
    await cp(new URL(`../${path}`, import.meta.url), join(f.project, path), { recursive: true });
  }
  const pkg = await json(join(f.project, 'package.json')); pkg.scripts.test = 'node --check skills/ready/cc/scripts/update.mjs';
  await writeFile(join(f.project, 'package.json'), JSON.stringify(pkg, null, 2));
  await git(['add', '.'], f.project); await git(['commit', '-m', 'Updater fixture payload'], f.project);
  const commit = await git(['rev-parse', 'HEAD'], f.project), before = await tree(f.home, ['repos', 'jobs', 'skills', '.grok']);
  let fail = true, builds = 0;
  // Only the remote transport and GitHub identity lookup are local substitutes.
  // npm ci, source checks, pack, extraction, installer, registration and HTTP
  // validation all execute their real processes and filesystem boundaries.
  const run = async (file, args, options = {}) => {
    if (file === 'gh') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'rosstheboss94/command-center' }) };
    if (file === 'npm' && args[0] === 'test') {
      builds++; if (fail) return execute(process.execPath, ['-e', 'process.exit(42)'], options);
    }
    if (file === 'git' && args[0] === 'clone' && args.includes(sourceURL)) {
      const result = await execute(file, args.map(arg => arg === sourceURL ? f.project : arg), options);
      if (result.code === 0) await git(['remote', 'set-url', 'origin', sourceURL], args.at(-1));
      return result;
    }
    if (file === 'git' && args[0] === 'fetch') args = args.map(arg => arg === 'origin' ? f.project : arg);
    return execute(file, args, options);
  };
  await assert.rejects(prepareUpdate(f.home, { run }), /Update npm test failed/);
  let status = await updateStatus(f.home); assert.equal(status.activeHome, f.home); assert.equal(status.candidates.length, 1);
  assert.equal(status.candidates[0].status, 'failed'); assert.equal(status.candidates[0].commit, commit);
  fail = false;
  const candidate = await prepareUpdate(f.home, { run });
  assert.equal(candidate.id, status.candidates[0].id); assert.equal(candidate.status, 'ready');
  await assert.rejects(assertActive(candidate.destination), /archived/);
  assert.equal((await json(join(candidate.destination, '.command-center.json'))).agents.length, 3);
  assert.deepEqual(await tree(f.home, ['repos', 'jobs', 'skills', '.grok']), before);
  const duplicate = await prepareUpdate(f.home, { run });
  assert.equal(duplicate.id, candidate.id); assert.equal(builds, 2);
  assert.equal((await updateStatus(f.home)).activeHome, f.home);
  assert.match(await readFile(join(candidate.destination, 'repos', f.repo, 'config.md'), 'utf8'), /projects\/rosstheboss94\/command-center/);
});
