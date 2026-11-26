import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDashboard } from '../skills/ready/cc/scripts/dashboard/server.mjs';
import { enqueue, tasks, dispatch } from '../skills/ready/cc/scripts/dashboard/tasks.mjs';
import { globalSlot } from '../skills/ready/cc/scripts/factory/admission.mjs';
import { get } from 'node:http';

test('localhost server rejects foreign origins and unauthenticated writes; serves CSP-protected UI', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cc-dashboard-')); await mkdir(join(home, 'repos'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const app = await startDashboard({ home, host: 'codex', port: 0, schedule: false, readBoard: async () => ({ repos: [], cards: [], sources: [] }) });
  t.after(() => app.close());
  let response = await fetch(app.url); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await response.text(), /Command Center/);
  response = await fetch(`${app.url}api/board`, { headers: { Origin: 'https://evil.invalid' } }); assert.equal(response.status, 403);
  response = await fetch(`${app.url}api/settings`, { method: 'POST', headers: { Origin: new URL(app.url).origin, 'Content-Type': 'application/json' }, body: '{"concurrency":2}' }); assert.equal(response.status, 403);
  response = await fetch(`${app.url}api/settings`, { method: 'POST', headers: { Origin: new URL(app.url).origin, 'Content-Type': 'application/json', 'X-CC-Token': app.token }, body: '{"concurrency":2}' }); assert.equal(response.status, 200);
  assert.equal(JSON.parse(await readFile(join(home, 'repos/factory.json'))).concurrency, 2);
  response = await fetch(`${app.url}api/action`, { method: 'POST', headers: { Origin: new URL(app.url).origin, 'Content-Type': 'application/json', 'X-CC-Token': app.token }, body: '{"action":"shell","repo":"../escape"}' }); assert.equal(response.status, 400);
  const badHost = await new Promise((resolve, reject) => { get(`${app.url}api/board`, { headers: { Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); }); assert.equal(badHost, 403);
  await globalSlot(home, { repo: 'other', id: 'live-job' }, async () => {
    response = await fetch(`${app.url}api/settings`, { method: 'POST', headers: { Origin: new URL(app.url).origin, 'Content-Type': 'application/json', 'X-CC-Token': app.token }, body: '{"concurrency":1}' });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(await readFile(join(home, 'repos/factory.json'))).concurrency, 1);
    await assert.rejects(globalSlot(home, { repo: 'new', id: 'new-job' }, async () => {}), /Home concurrency/);
  });
});
test('persistent task queue deduplicates clicks and dispatches without starting jobs while reading', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cc-tasks-')); t.after(() => rm(home, { recursive: true, force: true }));
  const first = await enqueue(home, { action: 'resume', repo: 'one', job: 'job' }, 'one:job');
  assert.equal((await enqueue(home, first.input, 'one:job')).id, first.id);
  await enqueue(home, { action: 'resume', repo: 'two', job: 'job' }, 'two:job');
  assert.equal((await tasks(home)).filter(t => t.status === 'queued').length, 2);
  const launched = []; await dispatch(home, 'grok', { launch: task => launched.push(task.id) });
  assert.equal(launched.length, 2); await dispatch(home, 'grok', { launch: task => launched.push(task.id) }); assert.equal(launched.length, 2);
});
