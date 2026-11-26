import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture } from './factory-fixture.mjs';
import { enqueue, taskRoot } from '../skills/ready/cc/scripts/dashboard/tasks.mjs';
import { executeTask } from '../skills/ready/cc/scripts/dashboard/worker.mjs';
import { atomic, json } from '../skills/ready/cc/scripts/factory/io.mjs';
import { listJobs } from '../skills/ready/cc/scripts/factory/store.mjs';
import { prepare, register } from '../skills/ready/cc/scripts/init.mjs';
import { loadContext } from '../skills/ready/cc/scripts/factory/project.mjs';
import { createJob, loadJob } from '../skills/ready/cc/scripts/factory/store.mjs';
import { recoverTask } from '../skills/ready/cc/scripts/dashboard/tasks.mjs';
import { readFile, writeFile } from 'node:fs/promises';

test('mock worker retries capacity without duplicating the issue job or recording feedback twice', async t => {
  const f = await fixture(t), root = await taskRoot(f.home);
  const issue = { number: 21, title: 'Local fixture issue', body: 'Task data', html_url: 'https://github.com/fixture/repo/issues/21' };
  const task = await enqueue(f.home, { action: 'start', repo: f.repo, issue }, 'issue-21');
  const path = join(root, `${task.id}.json`);
  const launch = async () => { const current = await json(path); await atomic(path, { ...current, status: 'launching', host: 'codex' }); };
  await launch(); await executeTask(f.home, task.id, { run: async () => { throw new Error('Home concurrency limit reached'); } });
  assert.equal((await json(path)).status, 'queued'); assert.equal((await listJobs(f.home, f.repo)).length, 1);
  await launch(); await executeTask(f.home, task.id, { run: async () => ({ stage: 'blocked' }) });
  assert.equal((await json(path)).status, 'finished'); assert.equal((await listJobs(f.home, f.repo)).length, 1);
  const response = await enqueue(f.home, { action: 'feedback', repo: f.repo, job: task.id, text: 'Keep literal $text; do not execute it' }, 'feedback');
  const feedbackPath = join(root, `${response.id}.json`); let count = 0;
  const runFeedback = async run => { await atomic(feedbackPath, { ...await json(feedbackPath), status: 'launching', host: 'codex' }); await executeTask(f.home, response.id, { recordFeedback: async () => { count++; }, run }); };
  await runFeedback(async () => { throw new Error('Repository concurrency limit reached'); });
  await runFeedback(async () => ({ stage: 'ready' }));
  assert.equal(count, 1); assert.equal((await json(feedbackPath)).status, 'finished');
});

test('explicit registration settings update validates checks and preserves unrelated Markdown', async t => {
  const f = await fixture(t), path = join(f.home, 'repos', f.repo, 'config.md');
  await writeFile(path, `${await readFile(path, 'utf8')}\n## Personal notes\nKeep this note.\n`);
  const report = await prepare({ home: f.home, cwd: f.project, source: f.project });
  await register({ home: f.home, report: report.reportPath, updateSettings: true, details: { purpose: 'Updated purpose', baseBranch: 'main', checks: [{ command: 'npm test', workingDirectory: '.', source: 'package.json' }], setupGaps: [], skills: ['test-driven-development'] } });
  const updated = await readFile(path, 'utf8'); assert.match(updated, /Updated purpose/); assert.match(updated, /Keep this note/);
});

test('interrupted task recovery refuses live owners and preserves engine recovery requirements', async t => {
  const f = await fixture(t), job = await createJob(await loadContext(f.home, f.repo, 'codex'), 'Recover fixture job');
  const task = await enqueue(f.home, { action: 'resume', repo: f.repo, job: job.id }, 'recover');
  const root = await taskRoot(f.home), path = join(root, `${task.id}.json`);
  await atomic(path, { ...task, status: 'interrupted', pid: process.pid });
  await assert.rejects(recoverTask(f.home, task.id), /dead owner/);
  await atomic(path, { ...task, status: 'interrupted', pid: 9999999 });
  await atomic(join(job.directory, 'execution.lock'), { pid: 9999999 });
  const recovered = await recoverTask(f.home, task.id);
  assert.equal(recovered.status, 'finished');
  const state = await loadJob(f.home, f.repo, job.id); assert.equal(state.stage, 'blocked'); assert.equal(state.requiresFeedback, true); assert.equal(state.interruptedStage, 'intake');
});
