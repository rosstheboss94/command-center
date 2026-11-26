import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { command } from '../factory.mjs';
import { runJob, feedback } from '../factory/engine.mjs';
import { loadContext } from '../factory/project.mjs';
import { createJob, listJobs } from '../factory/store.mjs';
import { atomic, json, transaction, identifier } from '../factory/io.mjs';
import { taskRoot } from './tasks.mjs';
import { configurationWrite, saveGlobalSettings } from '../factory/admission.mjs';
import { saveConfig, projectRecord } from '../factory/project.mjs';
import { register } from '../init.mjs';
import { hash } from '../factory/io.mjs';

export async function executeTask(home, id, { invoke = command, contextFor = loadContext, run = runJob, recordFeedback = feedback } = {}) {
 identifier(id);
 const root = await taskRoot(home), path = join(root, `${id}.json`);
 await transaction(join(root, `${id}.lock`), async () => {
  const task = await json(path);
  if (task.status !== 'launching') return;
  task.status = 'running'; task.pid = process.pid; task.started = new Date().toISOString(); await atomic(path, task);
  try {
    const { action, repo, job, text, issue } = task.input;
    const values = { home, repo, host: task.host, job };
    if (text !== undefined) { values.file = join(root, `${id}.txt`); await atomic(values.file, text); }
    if (action === 'settings') {
      task.result = await configurationWrite(home, async () => {
        if (!repo) return saveGlobalSettings(home, task.input.settings);
        const project = await projectRecord(home, repo);
        if (hash(project.markdown) !== task.input.markdownHash) throw new Error('Configuration changed while this save waited. Reload and save again.');
        return saveConfig(home, repo, task.input.settings, task.host, { replace: true });
      });
    } else if (action === 'register') {
      task.result = await configurationWrite(home, () => register({ home, cwd: home, report: task.input.report, details: task.input.details, updateSettings: true }));
    } else if (action === 'start') {
      const context = await contextFor(home, repo, task.host);
      const created = await transaction(join(root, `issue-${repo}-${issue.number}.lock`), async () => {
        const prior = (await listJobs(home, repo)).find(item => item.issue?.number === issue.number);
        if (prior) return prior;
        try { return await createJob(context, `${issue.title}\n\n${issue.body || ''}`, { issue: { number: issue.number, url: issue.html_url } }); }
        catch (cause) { const raced = (await listJobs(home, repo)).find(item => item.issue?.number === issue.number); if (raced) return raced; throw cause; }
      });
      task.job = created.id; await atomic(path, task);
      if (['blocked', 'failed', 'rejected', 'ready'].includes(created.stage)) throw new Error('This issue already has a saved job. Use its supported recovery actions.');
      task.result = await run(home, repo, created.id);
    } else if (action === 'feedback') {
      if (!task.feedbackRecorded) {
        await recordFeedback(home, repo, job, text); task.feedbackRecorded = true; await atomic(path, task);
      }
      task.result = await run(home, repo, job);
    } else task.result = await invoke(action, values);
    task.status = 'finished'; task.finished = new Date().toISOString();
  } catch (error) {
    task.error = error.message;
    task.status = /concurrency limit/.test(error.message) ? 'queued' : 'failed';
    if (task.status === 'queued') task.retryAt = Date.now() + 10000;
  }
  await atomic(path, task);
 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await executeTask(...process.argv.slice(2));
