import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { exists, json, alive } from '../factory/io.mjs';

export async function dashboardRecord(home) {
  const path = join(home, '.cc/dashboard/server.json');
  if (!await exists(path)) return null;
  const record = await json(path);
  if (!alive(record.pid)) return null;
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(record.url)) throw new Error('Unverifiable dashboard URL.');
  const response = await fetch(new URL('api/identity', record.url), { signal: AbortSignal.timeout(3000) });
  const identity = await response.json();
  if (identity.home !== home || identity.pid !== record.pid || identity.nonce !== record.nonce) throw new Error('Dashboard identity changed; inspect its process before activation.');
  return record;
}
async function launch(home, record) {
  const helper = join(home, 'skills/ready/cc/scripts/factory.mjs');
  const flatHelper = join(home, 'skills/cc/scripts/factory.mjs');
  const script = await exists(helper) ? helper : flatHelper;
  const server = join(home, await exists(helper) ? 'skills/ready/cc/scripts/dashboard/server.mjs' : 'skills/cc/scripts/dashboard/server.mjs');
  if (!await exists(server)) return { dashboard: null, instructions: `Use the bundled helper at ${script}; this archive has no bundled dashboard.` };
  await mkdir(join(home, '.cc/dashboard'), { recursive: true });
  const log = await open(join(home, '.cc/dashboard/launch.log'), 'a');
  try {
    const child = spawn(process.execPath, [script, 'dashboard', '--home', home, '--host', record.host, '--port', String(new URL(record.url).port)], { cwd: home, windowsHide: true, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    for (let attempt = 0; attempt < 80; attempt++) {
      await delay(100);
      if (!alive(child.pid)) throw new Error(`Candidate dashboard exited; inspect ${home}/.cc/dashboard/launch.log`);
      try { const ready = await dashboardRecord(home); if (ready?.pid === child.pid) return { dashboard: ready.url }; } catch { /* Wait for binding and the identity record. */ }
    }
    child.kill(); throw new Error('Candidate dashboard did not become ready.');
  } finally { await log.close(); }
}
export async function switchDashboard(from, to) {
  const record = await dashboardRecord(from);
  if (!record) return { dashboard: null, instructions: `Launch the bundled helper in ${to}.` };
  const response = await fetch(new URL('api/shutdown', record.url), { method: 'POST', headers: { Origin: new URL(record.url).origin, 'Content-Type': 'application/json', 'X-CC-Token': record.shutdownToken }, body: '{}' });
  if (!response.ok) throw new Error('Current dashboard refused shutdown.');
  for (let attempt = 0; attempt < 80 && alive(record.pid); attempt++) await delay(100);
  if (alive(record.pid)) throw new Error('Current dashboard process has not stopped.');
  try { return { ...await launch(to, record), undo: () => switchDashboard(to, from) }; }
  catch (error) { await launch(from, record); throw error; }
}
