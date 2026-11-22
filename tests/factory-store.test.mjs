import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomic, json, lock, safe } from '../skills/cc/scripts/factory/io.mjs';
import { createJob, loadJob, saveJob, listJobs, adoptJob } from '../skills/cc/scripts/factory/store.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'cc-factory-store-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const context = { home, repo: 'owner--repo', checkout: home, identity: 'github.com/owner/repo', baseBranch: 'main',
    markdown: '# Config', instructions: [], checks: [{ command: 'node --test', workingDirectory: '.', source: 'package.json' }],
    config: { schemaVersion: 1, concurrency: 3, maxRounds: 3, roles: {} } };
  return { home, context };
}
test('job creation freezes request/settings and deduplicates issue IDs under a lock', async t => {
  const { home, context } = await fixture(t);
  const issue = { number: 7, url: 'https://github.com/owner/repo/issues/7' };
  const job = await createJob(context, 'exact request', { issue });
  assert.equal((await loadJob(home, context.repo, job.id)).stage, 'intake');
  await assert.rejects(createJob(context, 'other', { issue }), /already has a job/);
  assert.equal((await listJobs(home, context.repo)).length, 1);
  assert.equal(await readFile(join(job.directory, 'request.md'), 'utf8'), 'exact request');
  await writeFile(join(job.directory, 'context.json'), '{}');
  await assert.rejects(loadJob(home, context.repo, job.id), /changed/);
});
test('state revision guards stale saves and immutable events preserve history', async t => {
  const { home, context } = await fixture(t);
  const job = await createJob(context, 'request');
  const stale = await loadJob(home, context.repo, job.id);
  job.stage = 'spec';
  await saveJob(job, 'accepted');
  stale.stage = 'ready';
  await assert.rejects(saveJob(stale, 'stale'), /revision/);
  const saved = await json(join(job.directory, 'state.json'));
  assert.equal(saved.history.length, 2);
});
test('a held lock cannot be silently removed or bypassed', async t => {
  const { home } = await fixture(t);
  const path = join(home, 'held.lock');
  await lock(path, async () => { await assert.rejects(lock(path, async () => {}), /lock exists/); });
  await lock(path, async () => {});
});
test('job IDs and symlinks cannot redirect factory storage', async t => {
  const { home } = await fixture(t);
  await assert.rejects(loadJob(home, '../escape', 'job'));
  const target = join(home, 'target'); await mkdir(target);
  try { await symlink(target, join(home, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(safe(home, join(home, 'linked/data.json')), /Linked/);
});
test('legacy jobs remain visible and adoption preserves old records', async t => {
  const { home, context } = await fixture(t);
  const directory = join(home, 'jobs', context.repo, 'legacy'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'progress.md'), '# Old history');
  assert.equal((await listJobs(home, context.repo))[0].legacy, true);
  await assert.rejects(adoptJob(context, 'legacy'), /request.md/);
  await writeFile(join(directory, 'request.md'), 'original request');
  const job = await adoptJob(context, 'legacy');
  assert.equal(job.stage, 'blocked');
  assert.equal(await readFile(join(directory, 'legacy-progress.md'), 'utf8'), '# Old history');
});
