#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { discoverHome } from './home.mjs';
import { loadContext, inspectConfig, saveConfig, projectRecord } from './factory/project.mjs';
import { createJob, listJobs, loadJob, adoptJob, saveJob } from './factory/store.mjs';
import { runJob, resumeJob, feedback, recover } from './factory/engine.mjs';
import { addIssue, queueIssues, processQueue, syncLabel } from './factory/github.mjs';
import { atomic, exists, safe, lock, git, json, inside, identifier } from './factory/io.mjs';

export const operations = ['config', 'add', 'start', 'run', 'status', 'resume', 'feedback', 'adopt', 'recover'];
async function requestFile(path) {
  if (!path) throw new Error('Supply --file with the exact UTF-8 request or feedback.');
  const text = await readFile(path, 'utf8');
  if (!text.trim() || Buffer.byteLength(text) > 1024 * 1024) throw new Error('Request must be nonempty and at most 1 MiB.');
  return text;
}
async function status(home, repo, id) {
  const describe = async job => {
    if (job.legacy) return job;
    const context = await json(join(job.directory, 'context.json'));
    const warnings = [];
    if (!(await exists(context.checkout))) warnings.push('Registered checkout is missing.');
    if (job.worktree && !(await exists(job.worktree))) warnings.push('Recorded worktree is missing.');
    else if (job.worktree && job.commit) {
      try { if (await git(['rev-parse', 'HEAD'], job.worktree) !== job.commit) warnings.push('HEAD changed; saved check/review evidence is stale.'); }
      catch (error) { warnings.push(error.message); }
    }
    if (await exists(join(job.directory, 'execution.lock'))) warnings.push('Execution lock exists; inspect recorded processes before retrying.');
    if (job.labelError) warnings.push(`GitHub label synchronization failed: ${job.labelError}`);
    return { ...job, warnings };
  };
  if (repo) return id ? describe(await loadJob(home, repo, id)) : Promise.all((await listJobs(home, repo)).map(describe));
  const root = await safe(home, join(home, 'jobs'));
  if (!(await exists(root))) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await Promise.all((await listJobs(home, entry.name)).map(describe)));
  }
  return result;
}
export async function command(operation, values, dependencies = {}) {
  if (!operations.includes(operation)) throw new Error('Unknown factory operation.');
  const { home } = await discoverHome({ home: values.home, cwd: values.cwd || process.cwd() });
  const repo = values.repo;
  if (operation === 'status') return status(home, repo, values.job);
  if (!repo) throw new Error('--repo is required.');
  identifier(repo);
  if (operation === 'config') return values.file
    ? saveConfig(home, repo, JSON.parse(await requestFile(values.file)), values.host)
    : inspectConfig(home, repo, values.host);
  if (operation === 'add') {
    const context = await projectRecord(home, repo, { requireBase: false });
    return { issue: await addIssue(context, await requestFile(values.file), dependencies) };
  }
  if (['resume', 'feedback', 'recover'].includes(operation)) {
    if (!values.job) throw new Error('--job is required.');
    if (operation === 'recover') return recover(home, repo, values.job);
    if (operation === 'feedback') await feedback(home, repo, values.job, await requestFile(values.file));
    if (values['sync-labels']) {
      const job = await loadJob(home, repo, values.job);
      await syncLabel(await json(join(job.directory, 'context.json')), job, dependencies);
      delete job.labelError;
      await saveJob(job, 'Explicit GitHub label synchronization completed.');
      return job;
    }
    return operation === 'resume' ? resumeJob(home, repo, values.job, dependencies) : runJob(home, repo, values.job, dependencies);
  }
  if (!['codex', 'claude', 'grok'].includes(values.host)) throw new Error('Supply --host codex, claude, or grok from the invoking host.');
  const context = await loadContext(home, repo, values.host);
  if (operation === 'adopt') {
    if (!values.job) throw new Error('--job is required.');
    let worktree, branch, baseCommit, commit;
    if (values.worktree) {
      worktree = await realpath(resolve(values.worktree));
      const common = async cwd => realpath(resolve(cwd, await git(['rev-parse', '--git-common-dir'], cwd)));
      if (await common(worktree) !== await common(context.checkout)) throw new Error('Legacy worktree belongs to another repository.');
      if (worktree === context.checkout) throw new Error('Adoption requires an isolated worktree, not the main registered checkout.');
      branch = await git(['branch', '--show-current'], worktree);
      if (!branch || branch === context.baseBranch) throw new Error('Legacy worktree needs a dedicated job branch.');
      baseCommit = await git(['merge-base', context.baseBranch, 'HEAD'], worktree);
      commit = await git(['rev-parse', 'HEAD'], worktree);
    }
    const job = await adoptJob(context, values.job, { worktree });
    if (worktree) {
      job.branch = branch; job.baseCommit = baseCommit; job.commit = commit;
      await saveJob(job, 'Validated legacy worktree branch and base commit; old reviews/checks remain invalid.');
    }
    return job;
  }
  if (operation === 'start') {
    const job = await createJob(context, await requestFile(values.file));
    return runJob(home, repo, job.id, dependencies);
  }
  if (operation === 'run') {
    const root = await safe(home, join(home, '.cc/factory/queues', repo));
    const snapshot = await lock(`${root}.lock`, async () => {
      const issues = await queueIssues(context, { ...dependencies, issue: values.issue });
      const prior = await listJobs(home, repo);
      const skipped = [], jobs = [];
      for (const issue of issues) {
        if (prior.some(job => job.issue?.number === issue.number)) { skipped.push(issue.number); continue; }
        const request = `${issue.title}\n\n${issue.body || ''}`;
        const job = await createJob(context, request, { issue: { number: issue.number, url: issue.html_url } });
        jobs.push(job.id); prior.push(job);
      }
      const snapshot = { id: randomUUID(), captured: new Date().toISOString(), issues: issues.map(issue => issue.number), jobs, skipped };
      await atomic(join(root, `${snapshot.id}.json`), snapshot);
      return snapshot;
    });
    const results = await processQueue(snapshot.jobs, context.config.concurrency, id => runJob(home, repo, id, dependencies));
    await atomic(join(root, `${snapshot.id}-results.json`), results);
    return { snapshot, results };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
      'home', 'cwd', 'repo', 'host', 'file', 'job', 'issue', 'worktree',
    ].map(name => [name, { type: 'string' }]).concat([['sync-labels', { type: 'boolean' }]])) });
    if (!positionals.length) console.log(JSON.stringify({ operations }));
    else {
      if (positionals.length !== 1) throw new Error('Use named options after one operation.');
      const result = await command(positionals[0], values);
      console.log(JSON.stringify({ ok: true, result }, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1;
  }
}
