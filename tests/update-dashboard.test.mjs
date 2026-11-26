import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { installHome } from '../installer/install.mjs';
import { dashboardRecord, switchDashboard } from '../skills/ready/cc/scripts/update/dashboard.mjs';
import { alive } from '../skills/ready/cc/scripts/factory/io.mjs';

test('managed dashboard cutover verifies identity and replaces the process on the same port, including rollback', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cc-dashboard-cutover-')), first = join(root, 'first'), second = join(root, 'second');
  await installHome(first, 'all'); await installHome(second, 'all');
  t.after(async () => {
    for (const home of [first, second]) {
      const record = await dashboardRecord(home).catch(() => null);
      if (record && alive(record.pid)) process.kill(record.pid);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const child = spawn(process.execPath, [join(first, 'skills/ready/cc/scripts/factory.mjs'), 'dashboard', '--home', first, '--host', 'codex', '--port', '0'], { stdio: 'ignore', windowsHide: true }); child.unref();
  let initial;
  for (let index = 0; index < 100 && !initial; index++) { initial = await dashboardRecord(first).catch(() => null); if (!initial) await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(initial); const moved = await switchDashboard(first, second);
  assert.equal(moved.dashboard, initial.url); assert.equal(alive(initial.pid), false);
  const replacement = await dashboardRecord(second); assert.notEqual(replacement.pid, initial.pid);
  await switchDashboard(second, first);
  assert.equal(alive(replacement.pid), false); assert.equal((await dashboardRecord(first)).url, initial.url);
});
