import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRecord } from '../factory/project.mjs';
import { listJobs } from '../factory/store.mjs';
import { exists, safe, execute } from '../factory/io.mjs';
import { boardCards } from './model.mjs';

export async function repositories(home) {
  const root = await safe(home, join(home, 'repos'));
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!(await exists(await safe(home, join(root, entry.name, 'config.md'))))) continue;
    try { const context = await projectRecord(home, entry.name, { requireBase: false });
      result.push({ id: entry.name, name: context.identity?.replace('github.com/', '') || entry.name, checkout: context.checkout, identity: context.identity });
    } catch (error) { result.push({ id: entry.name, name: entry.name, error: error.message }); }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
export async function githubSnapshot(context, run = execute) {
  if (!context.identity?.startsWith('github.com/')) return { issues: [], prs: [] };
  const repo = context.identity.slice(11);
  const gh = async args => {
    const result = await run('gh', args, { cwd: context.checkout, timeoutSeconds: 30 });
    if (result.code !== 0) throw new Error(result.stderr?.trim() || 'GitHub unavailable');
    return result.stdout;
  };
  await gh(['auth', 'status']);
  const identity = JSON.parse(await gh(['repo', 'view', repo, '--json', 'nameWithOwner']));
  if (identity.nameWithOwner.toLowerCase() !== repo.toLowerCase()) throw new Error('GitHub repository identity mismatch.');
  const pages = async suffix => {
    const items = [];
    for (let page = 1; page <= 1000; page++) {
      const batch = JSON.parse(await gh(['api', `repos/${repo}/${suffix}&per_page=100&page=${page}`]));
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub response.');
      if (!batch.length) return items;
      items.push(...batch);
    }
    throw new Error('GitHub pagination safety limit reached.');
  };
  const issues = (await pages('issues?state=all&sort=updated&direction=desc')).filter(issue => !issue.pull_request);
  const prs = (await pages('pulls?state=all&sort=updated&direction=desc')).map(pr => ({ number: pr.number, url: pr.html_url,
    headRefName: pr.head.ref, headRefOid: pr.head.sha, state: pr.merged_at ? 'MERGED' : pr.state.toUpperCase(), mergedAt: pr.merged_at }));
  return { issues, prs };
}
export function createBoardReader(home, { fetchGithub = githubSnapshot } = {}) {
  const cache = new Map(), localCache = new Map(), inFlight = new Map();
  return async ({ refresh = false } = {}) => {
    const repos = await repositories(home), cards = [], sources = [];
    for (const repo of repos) {
      let source = cache.get(repo.id) || { issues: [], prs: [], fetchedAt: null, attemptedAt: 0 };
      if (!repo.error && !inFlight.has(repo.id) && (refresh || Date.now() - source.attemptedAt >= 30000)) {
        source.attemptedAt = Date.now();
        cache.set(repo.id, source);
        const pending = (async () => {
          try { cache.set(repo.id, { ...await fetchGithub(await projectRecord(home, repo.id, { requireBase: false })), fetchedAt: new Date().toISOString(), attemptedAt: Date.now() }); }
          catch (error) { cache.set(repo.id, { ...source, error: error.message }); }
        })().finally(() => inFlight.delete(repo.id));
        inFlight.set(repo.id, pending);
      }
      if (refresh && inFlight.has(repo.id)) await inFlight.get(repo.id);
      source = cache.get(repo.id) || source;
      let jobs;
      try { jobs = await listJobs(home, repo.id); localCache.set(repo.id, jobs); }
      catch (error) { jobs = localCache.get(repo.id) || []; source = { ...source, error: `Local records: ${error.message}` }; }
      for (const job of jobs) {
        try { job.title = (await readFile(await safe(home, join(home, 'jobs', repo.id, job.id, 'request.md')), 'utf8')).split(/\r?\n/)[0]; }
        catch { /* Legacy requests may be unavailable. */ }
        if (!job.legacy) {
          const context = JSON.parse(await readFile(join(job.directory, 'context.json'), 'utf8'));
          job.maxRounds = context.config.maxRounds;
          job.blocking = context.config.blocking === true;
        }
      }
      cards.push(...boardCards(repo.id, jobs, source.issues, source.prs));
      sources.push({ repo: repo.id, fetchedAt: source.fetchedAt, syncing: inFlight.has(repo.id), error: repo.error || source.error || null });
    }
    return { repos, cards, sources };
  };
}
