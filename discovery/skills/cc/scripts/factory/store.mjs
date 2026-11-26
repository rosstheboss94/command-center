import { readFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, json, safe, identifier, exists, lock, hash, now } from './io.mjs';
import { stages } from './model.mjs';

async function root(home, repo) {
  const path = await safe(home, join(home, 'jobs', identifier(repo)));
  await mkdir(path, { recursive: true });
  return path;
}
export async function jobDirectory(home, repo, id) {
  return safe(home, join(home, 'jobs', identifier(repo), identifier(id)));
}
export async function listJobs(home, repo) {
  const directory = await safe(home, join(home, 'jobs', identifier(repo)));
  if (!(await exists(directory))) return [];
  const jobs = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = await jobDirectory(home, repo, entry.name);
    if (await exists(join(path, 'state.json'))) jobs.push(await loadJob(home, repo, entry.name));
    else jobs.push({ id: entry.name, repo, legacy: true, stage: 'legacy', directory: path });
  }
  return jobs.sort((a, b) => a.id.localeCompare(b.id));
}
export async function loadJob(home, repo, id) {
  const directory = await jobDirectory(home, repo, id);
  const job = await json(await safe(home, join(directory, 'state.json')));
  if (job.schemaVersion !== 1 || job.repo !== repo || job.id !== id || !stages.includes(job.stage) || !Number.isSafeInteger(job.revision)) throw new Error('Invalid factory job state.');
  if (!job.frozen || Object.keys(job.frozen).length !== 3) throw new Error('Incomplete frozen job inputs.');
  for (const [file, digest] of Object.entries(job.frozen)) {
    await safe(home, join(directory, file));
    if (!['request.md', 'context.json', 'config.md'].includes(file) || hash(await readFile(join(directory, file))) !== digest) throw new Error('Frozen job inputs changed; explicit reconciliation is required.');
  }
  return { ...job, directory };
}
async function progress(job) {
  const header = `# ${job.id}\n\n- Repo — ${job.repo}\n- Stage — ${job.stage}\n- Updated — ${job.updated}\n- Worktree — ${job.worktree || 'not prepared'}\n- Commit — ${job.commit || 'not recorded'}\n- PR — ${job.pr?.url || 'none'}\n`;
  await atomic(join(job.directory, 'progress.md'), `${header}\n## Blocker\n\n${job.blocker || 'None.'}\n\n## History\n\n${job.history.map(item => `- ${item.at} ${item.stage}: ${item.message}`).join('\n')}\n`);
}
export async function saveJob(job, message) {
  return lock(join(job.directory, 'state.lock'), async () => {
    const saved = await json(join(job.directory, 'state.json'));
    if (saved.revision !== job.revision) throw new Error('Stale job revision. Reload before updating.');
    job.revision++; job.updated = now();
    job.history.push({ at: job.updated, stage: job.stage, message });
    const { directory, ...state } = job;
    await atomic(join(directory, 'state.json'), state);
    await progress(job);
    return job;
  });
}
async function initialize(context, request, directory, id, options = {}) {
  const frozen = {};
  const inputs = { 'request.md': request, 'context.json': JSON.stringify(context, null, 2) + '\n', 'config.md': context.markdown };
  for (const [file, text] of Object.entries(inputs)) { await atomic(join(directory, file), text); frozen[file] = hash(text); }
  const job = { schemaVersion: 1, repo: context.repo, id, stage: options.adopted ? 'blocked' : 'intake', interruptedStage: options.adopted ? 'intake' : null,
    blocker: options.adopted ? 'Legacy job adopted. Confirm its request and worktree through feedback before refreshing all evidence.' : null,
    requiresFeedback: Boolean(options.adopted), blocking: context.config.blocking === true,
    revision: 0, created: now(), updated: now(), issue: options.issue || null, ...(options.priorJob ? { priorJob: options.priorJob } : {}), round: 0, frozen, reports: {}, attempts: [], checks: null,
    requiredReviews: [...(context.config.requiredReviews || ['review-code'])], history: [{ at: now(), stage: 'intake', message: options.adopted ? 'Adopted legacy records; old evidence is not trusted.' : 'Created job with frozen settings.' }] };
  await atomic(join(directory, 'state.json'), job);
  job.directory = directory;
  await progress(job);
  return job;
}
export async function createJob(context, request, options = {}) {
  if (typeof request !== 'string' || !request.trim()) throw new Error('An exact nonempty request is required.');
  const directory = await root(context.home, context.repo);
  return lock(join(directory, 'create.lock'), async () => {
    if (options.issue && (await listJobs(context.home, context.repo)).some(job => job.issue?.number === options.issue.number)) throw new Error('This issue already has a job; use resume.');
    const id = `${now().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
    const path = await safe(context.home, join(directory, id));
    await mkdir(path);
    return initialize(context, request, path, id, options);
  });
}
export async function adoptJob(context, id, { worktree } = {}) {
  const directory = await jobDirectory(context.home, context.repo, id);
  return lock(join(directory, 'adopt.lock'), async () => {
    if (await exists(join(directory, 'state.json'))) throw new Error('Job already uses the enforced engine.');
    if (!(await exists(join(directory, 'request.md')))) throw new Error('Legacy adoption requires request.md; preserve and identify the original request first.');
    for (const file of ['progress.md', 'config.md']) if (await exists(join(directory, file))) await copyFile(join(directory, file), join(directory, `legacy-${file}`), 1);
    const request = await readFile(join(directory, 'request.md'), 'utf8');
    const job = await initialize(context, request, directory, id, { adopted: true });
    if (worktree) { job.worktree = worktree; await saveJob(job, 'Recorded explicitly selected legacy worktree for reconciliation.'); }
    return job;
  });
}
