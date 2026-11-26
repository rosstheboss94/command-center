import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, exists, safe, identifier, json } from '../factory/io.mjs';
import { updateStatus, assertActive } from './state.mjs';
import { boardCards } from '../dashboard/model.mjs';
import { loadContext } from '../factory/project.mjs';
import { createJob } from '../factory/store.mjs';

export async function archives(home) {
  const state = await updateStatus(home);
  return state.generations.filter(path => path !== state.activeHome).map(path => ({ id: hash(path).slice(0, 16), home: path, readOnly: true }));
}
export async function archiveHome(home, id) {
  const archive = (await archives(home)).find(item => item.id === id);
  if (!archive) throw new Error('Unknown read-only archive.');
  return archive.home;
}
export async function archivedHistory(home) {
  const cards = [], errors = [];
  for (const archive of await archives(home)) {
    try {
      const root = await safe(archive.home, join(archive.home, 'jobs'));
      if (!await exists(root)) continue;
      for (const repo of await readdir(root, { withFileTypes: true })) {
        if (!repo.isDirectory()) continue;
        identifier(repo.name);
        const jobs = [];
        for (const entry of await readdir(await safe(archive.home, join(root, repo.name)), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const directory = await safe(archive.home, join(root, repo.name, identifier(entry.name)));
          const state = join(directory, 'state.json');
          // Archives display the original record even if old frozen validation
          // cannot be executed by today's helper. They never import its evidence.
          const job = await exists(state) ? await json(state) : { id: entry.name, repo: repo.name, stage: 'legacy', legacy: true };
          let request = '';
          if (await exists(join(directory, 'request.md'))) request = await readFile(await safe(archive.home, join(directory, 'request.md')), 'utf8');
          jobs.push({ ...job, id: entry.name, repo: repo.name, directory, title: request.split(/\r?\n/)[0] || entry.name, archivedRequest: request });
        }
        cards.push(...boardCards(repo.name, jobs, [], []).map(card => ({ ...card, key: `${archive.id}:${card.key}`, archive })));
      }
    } catch (error) { errors.push({ archive: archive.id, error: error.message }); }
  }
  return { cards, errors };
}
export async function createSuccessor(home, archiveId, repo, job, host) {
  await assertActive(home); identifier(repo); identifier(job);
  const previousHome = await archiveHome(home, archiveId);
  const request = await readFile(await safe(previousHome, join(previousHome, 'jobs', repo, job, 'request.md')), 'utf8');
  const context = await loadContext(home, repo, host);
  return createJob(context, request, { priorJob: { home: previousHome, repo, job, requestHash: hash(request) } });
}
