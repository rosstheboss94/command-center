import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardCards } from '../skills/ready/cc/scripts/dashboard/model.mjs';
import { globalSlot, globalSettings, saveGlobalSettings, configurationWrite } from '../skills/ready/cc/scripts/factory/admission.mjs';

test('board joins issue/job identity, retains evidence, and recognizes external completion', () => {
  const jobs = [{ id: 'job', repo: 'r', stage: 'blocked', interruptedStage: 'build', issue: { number: 10 }, updated: '2026-11-25', blocker: 'old blocker' }];
  const issues = [{ number: 10, title: 'Move skills', state: 'closed', closed_at: '2026-11-26', labels: [] }];
  const cards = boardCards('r', jobs, issues, []);
  assert.equal(cards.length, 1); assert.equal(cards[0].lane, 'done');
  assert.equal(cards[0].job.stage, 'blocked'); assert.equal(cards[0].title, 'Move skills');
  assert.equal(boardCards('r', jobs, [], [])[0].lane, 'blocked');
  const ready = { id: 'ready', stage: 'ready', branch: 'branch', commit: 'a'.repeat(40) };
  assert.equal(boardCards('r', [ready], [], [{ headRefName: 'branch', state: 'CLOSED', headRefOid: ready.commit }])[0].lane, 'blocked');
  assert.equal(boardCards('r', [ready], [], [{ headRefName: 'branch', state: 'OPEN', headRefOid: 'b'.repeat(40) }])[0].lane, 'blocked');
});
test('open unrelated issues are excluded; queued issues and standalone jobs remain distinct', () => {
  const cards = boardCards('r', [{ id: 'chat', stage: 'intake' }], [
    { number: 1, title: 'Queued', state: 'open', labels: [{ name: 'cc:queued' }] },
    { number: 2, title: 'Unrelated', state: 'open', labels: [] },
  ], []);
  assert.deepEqual(cards.map(c => c.lane), ['intake', 'queued']);
});
test('home admission spans repos, honors lowering, and releases slots on failure', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cc-admission-')); t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal((await globalSettings(home)).concurrency, 3);
  await globalSlot(home, { repo: 'one', id: 'a' }, () => globalSlot(home, { repo: 'two', id: 'b' }, () => globalSlot(home, { repo: 'three', id: 'c' }, async () => {
    await assert.rejects(globalSlot(home, { repo: 'four', id: 'd' }, async () => {}), /Home concurrency/);
    await assert.rejects(configurationWrite(home, async () => {}), /configuration waits/);
  })));
  await saveGlobalSettings(home, { concurrency: 1 });
  await globalSlot(home, { repo: 'one', id: 'a' }, async () => {
    await assert.rejects(globalSlot(home, { repo: 'two', id: 'b' }, async () => {}), /Home concurrency/);
  });
  await assert.rejects(globalSlot(home, { repo: 'two', id: 'b' }, async () => { throw new Error('failure'); }), /failure/);
  await globalSlot(home, { repo: 'two', id: 'b' }, async () => {});
  await assert.rejects(saveGlobalSettings(home, { concurrency: 0 }), /positive/);
});
