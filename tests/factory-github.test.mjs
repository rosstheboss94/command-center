import test from 'node:test';
import assert from 'node:assert/strict';
import { queueIssues, syncLabel, processQueue } from '../skills/cc/scripts/factory/github.mjs';
const context = { repo: 'owner--repo', identity: 'github.com/owner/repo', checkout: '.', config: { concurrency: 3 } };
test('queue pagination excludes pull requests and preserves oldest-first snapshot', async () => {
  const calls = [];
  const issues = await queueIssues(context, { run: async (file, args) => {
    calls.push(args);
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'owner/repo' }) };
    return { code: 0, stdout: JSON.stringify(/[?&]page=1$/.test(args[1]) ? [{ number: 2, title: 'task', body: 'data', html_url: 'url' }, { number: 3, pull_request: {} }] : []) };
  } });
  assert.deepEqual(issues.map(issue => issue.number), [2]);
  assert.ok(calls.some(args => args[1]?.includes('page=2')));
});
test('label sync adds status before removing other status labels', async () => {
  const calls = [];
  await syncLabel(context, { issue: { number: 7 }, stage: 'blocked' }, { run: async (file, args) => {
    calls.push(args);
    return { code: 0, stdout: args[0] === 'issue' && args[1] === 'view' ? JSON.stringify({ labels: [{ name: 'cc:running' }, { name: 'custom' }] }) : '' };
  } });
  const edits = calls.filter(args => args[0] === 'issue' && args[1] === 'edit');
  assert.ok(edits[0].includes('--add-label'));
  assert.ok(edits[1].includes('cc:running'));
  assert.ok(!edits.flat().includes('custom'));
});
test('queue workers respect concurrency and continue after a failure', async () => {
  let active = 0, peak = 0;
  const result = await processQueue([1, 2, 3, 4, 5], 3, async item => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (item === 2) throw new Error('failure'); return item;
  });
  assert.equal(peak, 3); assert.equal(result.length, 5);
  assert.equal(result[1].error, 'failure'); assert.equal(result[4].value, 5);
});
test('GitHub errors never become empty successful queues', async () => {
  await assert.rejects(queueIssues(context, { run: async () => ({ code: 1, stderr: 'authentication failed' }) }), /authentication failed/);
});

import { deliverJob, addIssue } from '../skills/cc/scripts/factory/github.mjs';
import { fixture } from './factory-fixture.mjs';
import { loadContext } from '../skills/cc/scripts/factory/project.mjs';
import { createJob, saveJob } from '../skills/cc/scripts/factory/store.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('delivery creates a draft once, verifies the head, and reuses the PR after retry', async t => {
  const f = await fixture(t); const ctx = await loadContext(f.home, f.repo, 'codex');
  ctx.identity = 'github.com/owner/repo'; ctx.baseBranch = 'main';
  const job = await createJob(ctx, 'Change application');
  job.branch = 'cc/test'; job.worktree = f.project; job.commit = 'a'.repeat(40);
  job.reports.spec = { artifact: 'Specification' }; job.checks = { passed: true, commit: job.commit }; job.requiredReviews = ['review-code'];
  await saveJob(job, 'fixture ready for publication');
  let pr, creates = 0, pushed;
  const run = async (file, args) => {
    if (file === 'git') { pushed = args; return { code: 0, stdout: '' }; }
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'owner/repo' }) };
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify(pr ? [pr] : []) };
    if (args[1] === 'create') {
      creates++;
      pr = { number: 1, url: 'https://github.com/owner/repo/pull/1', headRefOid: job.commit, state: 'OPEN', isDraft: true, baseRefName: 'main', body: await readFile(args[args.indexOf('--body-file') + 1], 'utf8') };
    }
    if (args[1] === 'ready') pr.isDraft = false;
    return { code: 0, stdout: '' };
  };
  const first = await deliverJob(job, ctx, { run });
  const second = await deliverJob(job, ctx, { run });
  assert.equal(creates, 1); assert.equal(first.url, second.url);
  assert.equal(pushed.at(-1), `${job.commit}:refs/heads/${job.branch}`);
  pr.headRefOid = 'b'.repeat(40);
  await assert.rejects(deliverJob(job, ctx, { run }), /verified job commit/);
});

test('cc add writes the exact idea through body-file without starting a job', async t => {
  const f = await fixture(t); const ctx = { ...context, home: f.home, checkout: f.project };
  const idea = 'A title\n\nLiteral $() and `backticks` remain data.';
  let recorded;
  const url = await addIssue(ctx, idea, { run: async (file, args) => {
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'owner/repo' }) };
    if (args[0] === 'issue') { recorded = await readFile(args[args.indexOf('--body-file') + 1], 'utf8'); return { code: 0, stdout: 'https://github.com/owner/repo/issues/8\n' }; }
    return { code: 0, stdout: '' };
  } });
  assert.equal(recorded, idea); assert.match(url, /issues\/8$/);
});
