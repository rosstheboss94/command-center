import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixture } from './factory-fixture.mjs';
import { createBoardReader, githubSnapshot } from '../skills/ready/cc/scripts/dashboard/data.mjs';

test('GitHub reads verify identity, paginate issues and PRs, and propagate authentication failures', async () => {
  const calls = []; const context = { identity: 'github.com/fixture/repo', checkout: '.' };
  const run = async (_file, args) => {
    calls.push(args);
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: '{"nameWithOwner":"fixture/repo"}' };
    const route = args[1]; const batch = route.includes('page=2') ? [] : route.includes('/issues?') ? [{ number: 1, state: 'open' }, { number: 2, pull_request: {} }] : [{ number: 3, html_url: 'https://github.com/fixture/repo/pull/3', head: { ref: 'branch', sha: 'a'.repeat(40) }, state: 'closed', merged_at: '2026-11-25' }];
    return { code: 0, stdout: JSON.stringify(batch) };
  };
  const result = await githubSnapshot(context, run); assert.equal(result.issues.length, 1); assert.equal(result.prs[0].state, 'MERGED');
  assert.equal(calls.filter(args => args[0] === 'api').length, 4);
  await assert.rejects(githubSnapshot(context, async () => ({ code: 1, stderr: 'not authenticated' })), /not authenticated/);
});
test('reader keeps the last successful GitHub snapshot during outages; all copied hosts serve the dashboard', async t => {
  const f = await fixture(t); let fail = false;
  const reader = createBoardReader(f.home, { fetchGithub: async () => { if (fail) throw new Error('offline'); return { issues: [{ number: 9, title: 'Retain this card', labels: [{ name: 'cc:queued' }] }], prs: [] }; } });
  const first = await reader({ refresh: true }); fail = true; const second = await reader({ refresh: true });
  assert.equal(second.cards[0].title, 'Retain this card'); assert.equal(second.sources[0].fetchedAt, first.sources[0].fetchedAt); assert.match(second.sources[0].error, /offline/);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const slowReader = createBoardReader(f.home, { fetchGithub: () => gate });
  const local = await slowReader(); assert.equal(local.sources[0].syncing, true); assert.equal(local.cards.length, 0);
  release({ issues: [], prs: [] }); await slowReader({ refresh: true });
  for (const folder of ['.agents', '.claude', '.grok']) {
    const root = join(f.home, folder, 'skills/cc/scripts/dashboard');
    const { startDashboard } = await import(pathToFileURL(join(root, 'server.mjs')));
    const app = await startDashboard({ home: f.home, host: folder === '.grok' ? 'grok' : folder === '.claude' ? 'claude' : 'codex', port: 0, schedule: false });
    try { const response = await fetch(`${app.url}api/board`); assert.equal(response.status, 200); assert.equal((await response.json()).repos.length, 1); }
    finally { await app.close(); }
  }
});
test('dashboard client parses as an ES module', () => {
  execFileSync(process.execPath, ['--check', 'skills/ready/cc/scripts/dashboard/public/app.mjs']);
});
