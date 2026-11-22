import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execute, git, atomic, safe } from './io.mjs';
import { saveJob } from './store.mjs';

function repository(context) {
  if (!/^github\.com\/[a-z0-9-]+\/[a-z0-9._-]+$/i.test(context.identity)) throw new Error('This operation requires a registered GitHub repository.');
  return context.identity.slice('github.com/'.length);
}
async function gh(context, args, run = execute) {
  const result = await run('gh', args, { cwd: context.checkout });
  if (result.code !== 0) throw new Error(`GitHub ${args[0]} failed: ${result.stderr?.trim() || 'unknown error'}`);
  return result.stdout;
}
async function verify(context, run) {
  const repo = repository(context);
  await gh(context, ['auth', 'status'], run);
  const remote = JSON.parse(await gh(context, ['repo', 'view', repo, '--json', 'nameWithOwner'], run));
  if (remote.nameWithOwner.toLowerCase() !== repo.toLowerCase()) throw new Error('GitHub repository identity mismatch.');
  return repo;
}
export async function queueIssues(context, { run = execute, issue } = {}) {
  const repo = await verify(context, run);
  if (issue !== undefined) {
    if (!Number.isSafeInteger(Number(issue)) || Number(issue) < 1) throw new Error('Issue must be a positive issue number.');
    const item = JSON.parse(await gh(context, ['api', `repos/${repo}/issues/${Number(issue)}`], run));
    if (item.pull_request || item.state !== 'open') throw new Error('Selected issue must be an open issue, not a PR.');
    return [item];
  }
  const issues = [];
  for (let page = 1; page <= 1000; page++) {
    const batch = JSON.parse(await gh(context, ['api', `repos/${repo}/issues?state=open&labels=cc%3Aqueued&sort=created&direction=asc&per_page=100&page=${page}`], run));
    if (!Array.isArray(batch)) throw new Error('Invalid GitHub issue response.');
    if (!batch.length) return issues;
    issues.push(...batch.filter(item => !item.pull_request));
  }
  throw new Error('Queue exceeds pagination safety limit. Narrow the repository queue.');
}
async function ensureLabel(context, label, run) {
  // A creation race may fail because another job created the label; verify it then.
  const result = await run('gh', ['label', 'create', label, '--repo', repository(context), '--color', label === 'cc:blocked' ? 'fbca04' : '1d76db', '--description', 'Command Center factory status'], { cwd: context.checkout });
  if (result.code !== 0) await gh(context, ['api', `repos/${repository(context)}/labels/${encodeURIComponent(label)}`], run);
}
export async function addIssue(context, text, { run = execute } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('A nonempty issue idea is required.');
  const repo = await verify(context, run);
  await ensureLabel(context, 'cc:queued', run);
  const path = await safe(context.home, join(context.home, '.cc/factory/requests', `${randomUUID()}.md`));
  await atomic(path, text);
  return (await gh(context, ['issue', 'create', '--repo', repo, '--title', text.trim().split(/\r?\n/)[0].slice(0, 120), '--body-file', path, '--label', 'cc:queued'], run)).trim();
}
export async function syncLabel(context, job, { run = execute } = {}) {
  if (!job.issue) return;
  const repo = repository(context);
  const label = job.stage === 'blocked' ? 'cc:blocked' : job.stage === 'ready' ? 'cc:ready' : job.stage === 'rejected' ? 'cc:rejected' : 'cc:running';
  const current = JSON.parse(await gh(context, ['issue', 'view', String(job.issue.number), '--repo', repo, '--json', 'labels'], run));
  await ensureLabel(context, label, run);
  await gh(context, ['issue', 'edit', String(job.issue.number), '--repo', repo, '--add-label', label], run);
  for (const other of ['cc:running', 'cc:blocked', 'cc:ready', 'cc:rejected']) {
    if (other !== label && current.labels.some(item => item.name === other)) await gh(context, ['issue', 'edit', String(job.issue.number), '--repo', repo, '--remove-label', other], run);
  }
}
export async function deliverJob(job, context, { run = execute } = {}) {
  const repo = await verify(context, run);
  const marker = `<!-- cc-job:${job.id} -->`;
  const lookup = async () => JSON.parse(await gh(context, ['pr', 'list', '--repo', repo, '--head', job.branch, '--state', 'all', '--limit', '100', '--json', 'number,url,headRefOid,state,isDraft,baseRefName,headRefName,body'], run));
  let matches = await lookup();
  if (matches.length > 1) throw new Error('Multiple PRs match the job branch; reconcile before delivery.');
  if (matches.length && (matches[0].baseRefName !== context.baseBranch || !matches[0].body.includes(marker))) throw new Error('Existing branch PR does not match this factory job.');
  if (matches[0]?.state === 'MERGED') {
    if (matches[0].headRefOid !== job.commit) throw new Error('Merged PR does not match the verified commit.');
    return { url: matches[0].url, head: matches[0].headRefOid, merged: true };
  }
  if (matches[0] && matches[0].state !== 'OPEN') throw new Error('The job PR was closed without merging; reconcile explicitly.');
  await git(['push', 'origin', `${job.commit}:refs/heads/${job.branch}`], job.worktree, run);
  const request = await readFile(join(job.directory, 'request.md'), 'utf8');
  const bodyFile = join(job.directory, 'pr-body.md');
  const body = `${marker}\n${request}\n\n${job.issue ? `Closes #${job.issue.number}\n\n` : ''}## Specification\n\n${job.reports.spec?.artifact || ''}\n\n## Validation\n\nCommit: ${job.commit}\n\n${JSON.stringify(job.checks, null, 2)}\n\nReviews: ${job.requiredReviews.join(', ')}\n`;
  await atomic(bodyFile, body);
  if (!matches.length) {
    await gh(context, ['pr', 'create', '--repo', repo, '--head', job.branch, '--base', context.baseBranch, '--draft', '--title', request.trim().split(/\r?\n/)[0].slice(0, 120), '--body-file', bodyFile], run);
  } else await gh(context, ['pr', 'edit', String(matches[0].number), '--repo', repo, '--body-file', bodyFile], run);
  matches = await lookup();
  if (matches.length !== 1 || matches[0].headRefOid !== job.commit || matches[0].baseRefName !== context.baseBranch || !matches[0].body.includes(marker)) throw new Error('Published PR does not match the verified job commit.');
  job.pr = { url: matches[0].url, head: matches[0].headRefOid, number: matches[0].number };
  await saveJob(job, 'Recorded verified PR pointer before marking ready.');
  if (matches[0].isDraft) await gh(context, ['pr', 'ready', String(matches[0].number), '--repo', repo], run);
  const final = await lookup();
  if (final.length !== 1 || final[0].isDraft || final[0].headRefOid !== job.commit) throw new Error('PR readiness or head verification failed.');
  return job.pr;
}
export async function processQueue(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { value: await worker(items[index]) }; }
      catch (error) { results[index] = { error: error.message }; }
    }
  }));
  return results;
}
