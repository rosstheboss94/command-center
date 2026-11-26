import { readdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { safe, atomic, exists, json, transaction, alive } from '../factory/io.mjs';
import { globalSettings } from '../factory/admission.mjs';
import { loadJob } from '../factory/store.mjs';
import { recover } from '../factory/engine.mjs';
import { identifier } from '../factory/io.mjs';

export const taskRoot = home => safe(home, join(home, '.cc/dashboard/tasks'));
export async function tasks(home) {
  const root = await taskRoot(home);
  if (!(await exists(root))) return [];
  return Promise.all((await readdir(root)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => json(join(root, name))));
}
export async function enqueue(home, input, key) {
  const root = await taskRoot(home);
  return transaction(join(root, 'queue.lock'), async () => {
    const prior = (await tasks(home)).find(task => task.key === key && ['queued', 'launching', 'running'].includes(task.status));
    if (prior) return prior;
    const task = { id: randomUUID(), key, input, status: 'queued', created: new Date().toISOString() };
    await atomic(join(root, `${task.id}.json`), task); return task;
  });
}
export async function dispatch(home, host, { launch } = {}) {
  const root = await taskRoot(home);
  return transaction(join(root, 'scheduler.lock'), async () => {
    const all = await tasks(home);
    for (const task of all.filter(task => task.status === 'running' && !alive(task.pid))) {
      task.status = 'interrupted'; task.error = 'Worker stopped. Inspect the recorded job and processes before retrying.';
      await atomic(join(root, `${task.id}.json`), task);
    }
    for (const task of all.filter(task => task.status === 'launching' && Date.now() - new Date(task.launchedAt || task.created) > 60000)) {
      task.status = 'interrupted'; task.error = 'Launch was interrupted. Inspect its process record before recovery.';
      await atomic(join(root, `${task.id}.json`), task);
    }
    // A launch without an owner is intentionally not retried: a child may be starting.
    const { concurrency } = await globalSettings(home);
    let count = all.filter(task => ['launching', 'running'].includes(task.status)).length;
    for (const task of all.filter(task => task.status === 'queued').sort((a, b) => a.created.localeCompare(b.created))) {
      if (count >= concurrency) break;
      if (task.retryAt && Date.now() < task.retryAt) continue;
      task.status = 'launching'; task.launchedAt = new Date().toISOString(); task.host = host; await atomic(join(root, `${task.id}.json`), task);
      try {
        if (launch) await launch(task);
        else {
          const log = await open(join(root, `${task.id}.log`), 'a');
          try {
            const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), home, task.id], { stdio: ['ignore', log.fd, log.fd], windowsHide: true, detached: true });
            await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
          } finally { await log.close(); }
        }
        count++;
      } catch (error) { task.status = 'failed'; task.error = error.message; await atomic(join(root, `${task.id}.json`), task); }
    }
  });
}
export async function recoverTask(home, id) {
  identifier(id); const root = await taskRoot(home), path = join(root, `${id}.json`);
  return transaction(join(root, 'scheduler.lock'), async () => {
    const task = await json(path);
    if (task.status !== 'interrupted' || (task.pid && alive(task.pid))) throw new Error('Only an interrupted operation with a dead owner can be reconciled.');
    const taskLock = join(root, `${id}.lock`);
    if (await exists(taskLock)) {
      const owner = await json(taskLock);
      if (!Number.isSafeInteger(owner.pid) || alive(owner.pid)) throw new Error('Worker lock owner is live or unverifiable.');
    }
    const jobId = task.job || task.input.job;
    if (!jobId) throw new Error('This operation has no saved job identity. Inspect GitHub and local records manually before retrying; it may have already performed its action.');
    let job = await loadJob(home, task.input.repo, jobId);
    if ((job.attempts || []).some(attempt => !attempt.finished && attempt.childPid && alive(attempt.childPid))) throw new Error('A recorded job child is still live.');
    if (await exists(join(job.directory, 'execution.lock'))) job = await recover(home, task.input.repo, jobId);
    if (await exists(taskLock)) await unlink(taskLock);
    if (['blocked', 'failed', 'ready', 'rejected'].includes(job.stage)) { task.status = 'finished'; task.result = job; task.error = null; }
    else { task.status = 'queued'; task.error = null; task.retryAt = null; }
    await atomic(path, task); return task;
  });
}
