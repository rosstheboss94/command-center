import test from 'node:test';
import assert from 'node:assert/strict';
import { queueIssues, syncLabel, processQueue, restartOptions, blockCommentBody, commentOnBlock } from '../skills/cc/scripts/factory/github.mjs';
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
import { readFile, access } from 'node:fs/promises';
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

test('restart options and block comment bodies quote the blocker without executing it', () => {
  const stage = 'build';
  const failure = 'disk full';
  const first = restartOptions(stage, failure);
  assert.deepEqual(first, restartOptions(stage, failure));
  assert.equal(new Set(Object.values(first)).size, 3);
  for (const text of Object.values(first)) assert.equal(['Option A', 'Option B', 'Option C'].includes(text), false);
  const other = restartOptions(stage, 'other failure');
  for (const text of Object.values(first)) assert.equal(Object.values(other).includes(text), false);
  assert.equal(first.a, `Resume this same job at ${stage} and correct the cause of this blocker, then continue from ${stage}. Choosing a restarts this same job from ${stage}. Blocker: ${failure}`);
  assert.equal(first.b, `Resume this same job at ${stage} and narrow the work so this blocker no longer applies, then continue from ${stage}. Choosing b restarts this same job from ${stage}. Blocker: ${failure}`);
  assert.equal(first.c, `Resume this same job at ${stage} and keep the original request, treating this blocker as a constraint the stage must satisfy, then continue from ${stage}. Choosing c restarts this same job from ${stage}. Blocker: ${failure}`);
  assert.equal(restartOptions(stage).a.endsWith('Blocker: '), true);
  assert.equal(restartOptions(stage, { unexpected: true }).a.endsWith('Blocker: '), true);
  const id = 'job-1';
  const repo = 'fixture--cc-factory';
  assert.equal(blockCommentBody({ id, repo, stage, blocker: failure }), `Job: ${id}\nInterrupted stage: ${stage}\nBlocker and restart options:\n\`\`\`text\n${failure}\n\na. ${first.a}\nb. ${first.b}\nc. ${first.c}\n\`\`\`\n\nReply with text that is exactly one letter: a, b, or c.\nCommand: cc feedback ${repo} ${id} <letter>\nHelper: feedback --repo ${repo} --job ${id} --file <feedback-file>\nChoosing a, b, or c restarts this same job from ${stage} and does not open a second job.\n`);
  const hostile = 'line1\n`code`\n````fence\n$(echo pwned)\n"quotes"';
  const fenced = blockCommentBody({ id, repo, stage, blocker: hostile });
  const marker = '`'.repeat(5);
  assert.equal(fenced.includes(`${marker}text\n${hostile}\n\na. `), true);
  assert.equal(fenced.includes(`\n${marker}\n\nReply with text that is exactly one letter: a, b, or c.\n`), true);
  assert.equal(fenced.includes('<feedback-file>'), true);
  assert.equal(fenced.includes('C:\\Users'), false);
});

test('commentOnBlock checks identity before writing and accepts only the verified issue URL', async t => {
  const f = await fixture(t, { github: true });
  const ctx = await loadContext(f.home, f.repo, 'codex');
  assert.equal(ctx.identity, 'github.com/fixture/cc-factory');
  const job = await createJob(ctx, 'Comment on block', { issue: { number: 7, url: 'https://github.com/fixture/cc-factory/issues/7' } });
  job.interruptedStage = 'build';
  job.blocker = 'boom `tick` $(echo pwned)';
  job.worktree = f.project;
  const bodyPath = join(job.directory, 'block-comment.md');
  const calls = [];
  const run = async (file, args) => {
    calls.push(args);
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'fixture/cc-factory' }) };
    if (args[1] === 'comment') return { code: 0, stdout: 'HTTPS://GitHub.com/Fixture/cc-factory/issues/7#issuecomment-15\n' };
    return { code: 0, stdout: '' };
  };
  await assert.rejects(commentOnBlock(null, job, { run }), /job context is required/i);
  await assert.rejects(commentOnBlock(ctx, { ...job, issue: { number: 0 } }, { run }), /positive safe integer/);
  await assert.rejects(commentOnBlock(ctx, { ...job, issue: { number: '7' } }, { run }), /positive safe integer/);
  await assert.rejects(commentOnBlock(ctx, { ...job, issue: { number: 1.5 } }, { run }), /positive safe integer/);
  await assert.rejects(commentOnBlock(ctx, { ...job, interruptedStage: 'ready' }, { run }), /Interrupted stage/);
  await assert.rejects(commentOnBlock(ctx, { ...job, interruptedStage: 'blocked' }, { run }), /Interrupted stage/);
  await assert.rejects(commentOnBlock(ctx, { ...job, interruptedStage: 'rejected' }, { run }), /Interrupted stage/);
  assert.equal(calls.length, 0);
  const mismatch = [];
  await assert.rejects(commentOnBlock(ctx, job, { run: async (file, args) => {
    mismatch.push(args);
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'other/repo' }) };
    if (args[1] === 'comment') throw new Error('comment must not run');
    return { code: 0, stdout: '' };
  } }), /identity mismatch/);
  assert.equal(mismatch.some(args => args[1] === 'comment'), false);
  await assert.rejects(access(bodyPath), { code: 'ENOENT' });
  job.worktree = job.directory;
  const insideCalls = [];
  await assert.rejects(commentOnBlock(ctx, job, { run: async (file, args) => {
    insideCalls.push(args);
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'fixture/cc-factory' }) };
    if (args[1] === 'comment') throw new Error('comment must not run');
    return { code: 0, stdout: '' };
  } }), /outside the worktree/);
  assert.equal(insideCalls.some(args => args[1] === 'comment'), false);
  await assert.rejects(access(bodyPath), { code: 'ENOENT' });
  job.worktree = f.project;
  const url = await commentOnBlock(ctx, job, { run });
  assert.equal(url, 'HTTPS://GitHub.com/Fixture/cc-factory/issues/7#issuecomment-15');
  const commentArgs = calls.filter(args => args[1] === 'comment');
  assert.deepEqual(commentArgs, [['issue', 'comment', '7', '--repo', 'fixture/cc-factory', '--body-file', bodyPath]]);
  const body = await readFile(bodyPath, 'utf8');
  assert.equal(body, blockCommentBody({ id: job.id, repo: job.repo, stage: 'build', blocker: job.blocker }));
  assert.equal(body.includes('$(echo pwned)'), true);
  for (const args of calls) for (const arg of args) {
    assert.equal(arg.includes('$(echo pwned)'), false);
    assert.equal(arg.includes('`tick`'), false);
  }
  for (const stdout of [
    'https://github.com/other/cc-factory/issues/7#issuecomment-1',
    'https://github.com/fixture/cc-factory/issues/8#issuecomment-1',
    'https://github.com/fixture/cc-factory/issues/7#issuecomment-',
    'https://github.com/fixture/cc-factory/issues/7#issuecomment-1a',
    'https://github.com/fixture/cc-factory/issues/7',
    'not a url',
  ]) {
    await assert.rejects(commentOnBlock(ctx, job, { run: async (file, args) => {
      if (args[0] === 'auth') return { code: 0, stdout: '' };
      if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'fixture/cc-factory' }) };
      if (args[1] === 'comment') return { code: 0, stdout };
      return { code: 0, stdout: '' };
    } }), /did not match issue 7/);
  }
  await assert.rejects(commentOnBlock(ctx, job, { run: async (file, args) => {
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'fixture/cc-factory' }) };
    if (args[1] === 'comment') return { code: 1, stderr: 'comment denied\n', stdout: '' };
    return { code: 0, stdout: '' };
  } }), /GitHub issue failed: comment denied/);
  const dotted = { ...ctx, identity: 'github.com/fixture/cc.factory' };
  await assert.rejects(commentOnBlock(dotted, job, { run: async (file, args) => {
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'fixture/cc.factory' }) };
    if (args[1] === 'comment') return { code: 0, stdout: 'https://github.com/fixture/ccXfactory/issues/7#issuecomment-1' };
    return { code: 0, stdout: '' };
  } }), /did not match issue 7/);
  const dottedUrl = await commentOnBlock(dotted, job, { run: async (file, args) => {
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'fixture/cc.factory' }) };
    if (args[1] === 'comment') return { code: 0, stdout: 'https://github.com/fixture/cc.factory/issues/7#issuecomment-3' };
    return { code: 0, stdout: '' };
  } });
  assert.equal(dottedUrl, 'https://github.com/fixture/cc.factory/issues/7#issuecomment-3');
});
