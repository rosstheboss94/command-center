import { mkdir, readdir, readFile, open, unlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exists, safe, json, atomic, alive, identifier, now } from '../factory/io.mjs';
import { validateHome } from '../home.mjs';

export async function updateRoot(home) {
  const parent = await realpath(dirname(resolve(home)));
  return safe(parent, join(parent, '.command-center-updates'));
}
export async function updateStatus(home) {
  const root = await updateRoot(home), path = join(root, 'active.json');
  const active = await exists(path) ? await json(path) : { activeHome: await realpath(home), previousHome: null, generations: [await realpath(home)], revision: 0 };
  const candidates = [], directory = join(root, 'candidates');
  if (await exists(directory)) for (const name of await readdir(directory)) {
    const path = await safe(root, join(directory, identifier(name), 'journal.json'));
    if (await exists(path)) candidates.push(await json(path));
  }
  return { ...active, root, candidates };
}
export async function assertActive(home, { allowActivation = false } = {}) {
  const state = await updateStatus(home);
  if (await realpath(home) !== state.activeHome) throw new Error(`This home is archived and read-only. Use the bundled helper in ${state.activeHome}.`);
  if (!allowActivation && await exists(join(state.root, 'activate.lock'))) throw new Error('Factory activation is in progress; retry after cutover.');
}
export async function updateLock(home, kind, action) {
  if (!['prepare', 'activate'].includes(kind)) throw new Error('Unknown update lock.');
  const root = await updateRoot(home); await mkdir(root, { recursive: true });
  const path = await safe(root, join(root, `${kind}.lock`));
  if (await exists(path)) {
    const prior = await json(path);
    if (!Number.isSafeInteger(prior.pid) || alive(prior.pid) || !Array.isArray(prior.children) || prior.children.some(pid => !Number.isSafeInteger(pid) || alive(pid))) throw new Error('Update lock is owned by a live or unverifiable process/child.');
    // No owner or child can still mutate the candidate. Preserve recovery evidence.
    await atomic(join(root, `recovered-${kind}-${randomUUID()}.json`), { ...prior, recovered: now() });
    await unlink(path);
  }
  const handle = await open(path, 'wx'), owner = { pid: process.pid, children: [], started: now() };
  const recordChild = async pid => { owner.children.push(pid); await handle.truncate(0); await handle.write(JSON.stringify(owner), 0); await handle.sync(); };
  try { await handle.write(JSON.stringify(owner), 0); return await action({ recordChild }); }
  finally { await handle.close(); await unlink(path); }
}
export async function assertIdle(home) {
  async function scan(rel) {
    const path = await safe(home, join(home, rel)), info = await exists(path);
    if (!info) return;
    if (info.isDirectory()) { for (const name of await readdir(path)) await scan(`${rel}/${name}`); return; }
    if (rel.endsWith('.lock')) throw new Error(`Factory lock requires inspection: ${path}`);
    if (!rel.endsWith('.json')) return;
    if (rel.endsWith('/state.json')) {
      const job = await json(path);
      if (['intake', 'spec', 'plan', 'build', 'verify', 'review', 'approve', 'deliver'].includes(job.stage)) throw new Error(`Unfinished factory job: ${path}`);
      if ((job.attempts || []).some(item => item.childPid && alive(item.childPid))) throw new Error(`Factory role child process is live: ${path}`);
    } else if (rel.startsWith('.cc/dashboard/tasks/') && !rel.endsWith('/queue.lock')) {
      const task = await json(path);
      if (['queued', 'launching', 'running'].includes(task.status) || (task.pid && alive(task.pid))) throw new Error(`Pending dashboard work: ${path}`);
    } else if (rel.endsWith('/leases.json') && (await json(path)).length) throw new Error(`Factory admission leases require inspection: ${path}`);
  }
  await scan('jobs'); await scan('.cc/factory/slots'); await scan('.cc/factory/global'); await scan('.cc/dashboard/tasks');
}
export async function activate(home, id, { validate, switchDashboard } = {}) {
  identifier(id);
  return updateLock(home, 'activate', async () => {
    await assertActive(home, { allowActivation: true });
    const state = await updateStatus(home);
    if (await exists(join(state.root, 'prepare.lock'))) throw new Error('An update preparation process must finish first.');
    const path = await safe(state.root, join(state.root, 'candidates', id, 'journal.json')), candidate = await json(path);
    if (candidate.sourceHome !== await realpath(home) || candidate.status !== 'ready' || candidate.validation?.passed !== true) throw new Error('Candidate is not ready for this active home.');
    await assertIdle(home); await assertIdle(candidate.destination);
    await validateHome(candidate.destination);
    if (!validate) { const { validateCandidate } = await import('./prepare.mjs'); validate = validateCandidate; }
    await validate(candidate);
    if (switchDashboard) await switchDashboard(home, candidate.destination);
    const active = { activeHome: candidate.destination, sourceCommit: candidate.commit, previousHome: state.activeHome,
      generations: [...new Set([...state.generations, candidate.destination])], revision: state.revision + 1, activated: now(), candidate: id };
    await atomic(join(state.root, 'active.json'), active);
    await atomic(join(state.root, `activation-${active.revision}.json`), active);
    return active;
  });
}
export async function rollback(home, { switchDashboard } = {}) {
  return updateLock(home, 'activate', async () => {
    await assertActive(home, { allowActivation: true }); const state = await updateStatus(home);
    if (!state.previousHome) throw new Error('No previous home is recorded.');
    if (await exists(join(state.root, 'prepare.lock'))) throw new Error('An update preparation process must finish first.');
    await assertIdle(home); await assertIdle(state.previousHome); await validateHome(state.previousHome);
    if (switchDashboard) await switchDashboard(home, state.previousHome);
    const installation = join(state.previousHome, '.cc/installation.json');
    const active = { ...state, candidates: undefined, root: undefined, activeHome: state.previousHome, previousHome: state.activeHome,
      sourceCommit: await exists(installation) ? (await json(installation)).commit : null, revision: state.revision + 1, activated: now(), candidate: null };
    await atomic(join(state.root, 'active.json'), active); await atomic(join(state.root, `activation-${active.revision}.json`), active); return active;
  });
}
