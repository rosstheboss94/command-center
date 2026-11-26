import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { atomic, hash, alive, exists } from '../skills/ready/cc/scripts/factory/io.mjs';
import { updateRoot, updateLock, updateStatus, assertIdle, assertActive, activate, rollback } from '../skills/ready/cc/scripts/update/state.mjs';
import { inventory, customizations, verifyInventory } from '../skills/ready/cc/scripts/update/inventory.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'old'), candidate = join(root, 'new');
  for (const path of [home, candidate]) {
    await mkdir(join(path, 'skills/ready/cc'), { recursive: true }); await mkdir(join(path, 'repos'));
    await writeFile(join(path, 'AGENTS.md'), 'instructions'); await writeFile(join(path, 'skills/ready/cc/SKILL.md'), 'cc');
    await atomic(join(path, '.command-center.json'), { kind: 'command-center-home', schemaVersion: 1, templateVersion: '0.4.0', agents: [] });
  }
  return { root, home, candidate };
}
test('inventory detects edits, additions, deletions and reconciled canonical customizations', async t => {
  const { home, candidate } = await fixture(t);
  const files = await inventory(home); await atomic(join(home, '.cc/install-manifest.json'), { schemaVersion: 1, files });
  await writeFile(join(home, 'skills/ready/cc/SKILL.md'), 'custom');
  await writeFile(join(home, 'skills/ready/cc/custom.txt'), 'extra');
  let report = await customizations(home, candidate);
  assert.deepEqual(report.conflicts.map(v => v.path).sort(), ['skills/ready/cc/SKILL.md', 'skills/ready/cc/custom.txt']);
  await writeFile(join(candidate, 'skills/ready/cc/SKILL.md'), 'custom');
  await writeFile(join(candidate, 'skills/ready/cc/custom.txt'), 'extra');
  assert.equal((await customizations(home, candidate)).conflicts.length, 0);
  await assert.rejects(verifyInventory(home, files), /inventory/);
  assert.equal(files['AGENTS.md'], hash('instructions'));
});
test('exclusive locks refuse live owners and recover dead owners only without live children', async t => {
  const { home } = await fixture(t), root = await updateRoot(home), path = join(root, 'prepare.lock');
  await updateLock(home, 'prepare', async () => {
    await assert.rejects(updateLock(home, 'prepare', async () => {}), /live|owned/);
  });
  await atomic(path, { pid: 2147483647, children: [process.pid] });
  await assert.rejects(updateLock(home, 'prepare', async () => {}), /child|live/);
  await atomic(path, { pid: 2147483647, children: [] });
  await updateLock(home, 'prepare', async () => {});
});
test('simultaneous stale-lock recoverers never overlap their critical sections', async t => {
  const { home } = await fixture(t), root = await updateRoot(home); let active = 0, overlaps = 0;
  for (let index = 0; index < 20; index++) {
    await atomic(join(root, 'prepare.lock'), { pid: 2147483647, children: [] });
    await Promise.allSettled([1, 2, 3].map(() => updateLock(home, 'prepare', async () => {
      active++; if (active > 1) overlaps++;
      await new Promise(resolve => setTimeout(resolve, 10)); active--;
    })));
  }
  assert.equal(overlaps, 0);
});
test('process termination leaves a recoverable lock while an orphaned recorded child prevents recovery', async t => {
  const { home } = await fixture(t);
  const module = new URL('../skills/ready/cc/scripts/update/state.mjs', import.meta.url).href;
  const script = `import {spawn} from 'node:child_process'; const {updateLock}=await import(process.argv[1]); await updateLock(process.argv[2],'prepare',async ({recordChild})=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});await recordChild(child.pid);console.log(child.pid);await new Promise(()=>{});});`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script, module, home], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const childPid = await new Promise((resolve, reject) => { parent.once('error', reject); parent.stdout.once('data', bytes => resolve(Number(bytes.toString().trim()))); });
  t.after(() => { if (alive(parent.pid)) parent.kill(); if (alive(childPid)) process.kill(childPid); });
  parent.kill(); await new Promise(resolve => parent.once('exit', resolve));
  assert.ok(await exists(join(await updateRoot(home), 'prepare.lock')));
  await assert.rejects(updateLock(home, 'prepare', async () => {}), /child|live/);
  process.kill(childPid);
  for (let index = 0; index < 100 && alive(childPid); index++) await new Promise(resolve => setTimeout(resolve, 10));
  await updateLock(home, 'prepare', async () => {});
});
test('a deletion reconciles only when a prepared candidate also omits the canonical file', async t => {
  const { home, candidate } = await fixture(t);
  await writeFile(join(home, 'skills/ready/cc/obsolete.txt'), 'obsolete');
  await atomic(join(home, '.cc/install-manifest.json'), { files: await inventory(home) });
  await rm(join(home, 'skills/ready/cc/obsolete.txt'));
  assert.equal((await customizations(home)).conflicts.length, 1);
  assert.equal((await customizations(home, candidate)).conflicts.length, 0);
  await mkdir(join(candidate, 'skills/unready/cc'), { recursive: true });
  await writeFile(join(candidate, 'skills/unready/cc/obsolete.txt'), 'obsolete');
  assert.equal((await customizations(home, candidate)).conflicts.length, 1);
});
test('idle checks include role children, execution locks, slots and pending dashboard work', async t => {
  const { home } = await fixture(t);
  await mkdir(join(home, 'jobs/r/j'), { recursive: true });
  await atomic(join(home, 'jobs/r/j/state.json'), { stage: 'blocked', attempts: [{ childPid: process.pid }] });
  await assert.rejects(assertIdle(home), /process|child/);
  await atomic(join(home, 'jobs/r/j/state.json'), { stage: 'blocked', attempts: [] });
  await writeFile(join(home, 'jobs/r/j/execution.lock'), '{}');
  await assert.rejects(assertIdle(home), /lock/);
  await rm(join(home, 'jobs/r/j/execution.lock')); await assertIdle(home);
  await atomic(join(home, '.cc/dashboard/tasks/t.json'), { status: 'queued' });
  await assert.rejects(assertIdle(home), /dashboard|queued/);
});
test('activation is explicit, validation failure is isolated, archive writes refuse, rollback preserves generations', async t => {
  const { home, candidate } = await fixture(t), root = await updateRoot(home);
  const record = { id: 'candidate', sourceHome: home, destination: candidate, commit: 'a'.repeat(40), status: 'ready', validation: { passed: true } };
  await atomic(join(root, 'candidates/candidate/journal.json'), record);
  assert.equal((await updateStatus(home)).activeHome, home);
  await assert.rejects(activate(home, 'candidate', { validate: async () => { throw new Error('invalid'); } }), /invalid/);
  assert.equal((await updateStatus(home)).activeHome, home);
  await activate(home, 'candidate', { validate: async () => {} });
  assert.equal((await updateStatus(candidate)).activeHome, candidate);
  await assert.rejects(assertActive(home), /archived/);
  await rollback(candidate);
  assert.equal((await updateStatus(home)).activeHome, home);
  assert.equal(await readFile(join(candidate, 'AGENTS.md'), 'utf8'), 'instructions');
});
