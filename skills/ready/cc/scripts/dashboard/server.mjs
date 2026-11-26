import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBoardReader } from './data.mjs';
import { lanes, laneNames } from './model.mjs';
import { enqueue, tasks, dispatch, recoverTask } from './tasks.mjs';
import { globalSettings, saveGlobalSettings, configurationWrite } from '../factory/admission.mjs';
import { projectRecord, inspectConfig, saveConfig } from '../factory/project.mjs';
import { queueIssues } from '../factory/github.mjs';
import { loadJob } from '../factory/store.mjs';
import { prepare, register, savedSettings } from '../init.mjs';
import { effectiveConfig, positive } from '../factory/model.mjs';
import { identifier, hash, exists, json, safe } from '../factory/io.mjs';

const assets = { '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const error = (message, status = 400) => Object.assign(new Error(message), { status });
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw error('Use application/json.', 415);
  const buffers = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw error('Request exceeds 1 MiB.', 413); buffers.push(chunk); }
  const value = JSON.parse(Buffer.concat(buffers).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('Expected an object.');
  return value;
}
export async function startDashboard({ home, host, port = 4310, schedule = true, readBoard = createBoardReader(home) }) {
  if (!['codex', 'claude', 'grok'].includes(host)) throw error('Supply --host codex, claude, or grok.');
  const token = randomBytes(32).toString('hex'), prepared = new Map();
  let origin, boardPromise;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cache-Control', 'no-store');
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)
        || request.headers['sec-fetch-site'] === 'cross-site') throw error('Foreign origin or Host refused.', 403);
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname]; let bytes = await readFile(new URL(`./public/${file}`, import.meta.url));
        if (file === 'index.html') bytes = Buffer.from(bytes.toString().replace('__CC_TOKEN__', token));
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); response.end(bytes); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/board') {
        boardPromise ||= readBoard({ refresh: url.searchParams.get('refresh') === '1' }).finally(() => { boardPromise = null; });
        return send(200, { ...await boardPromise, lanes, laneNames, operations: await tasks(home), settings: await globalSettings(home), host });
      }
      if (request.method === 'GET' && url.pathname === '/api/settings') {
        const repo = url.searchParams.get('repo');
        if (!repo) return send(200, await globalSettings(home));
        identifier(repo); const project = await projectRecord(home, repo, { requireBase: false });
        const path = await safe(home, join(home, 'repos', repo, 'factory.json'));
        const saved = await exists(path) ? await json(path) : null;
        let config, conflict;
        try { config = (await inspectConfig(home, repo, host)).config; } catch (cause) { conflict = cause.message; }
        return send(200, { markdown: project.markdown, markdownHash: hash(project.markdown), settings: saved?.settings || {}, config, conflict });
      }
      if (request.method === 'GET' && url.pathname === '/api/job') {
        const { command } = await import('../factory.mjs');
        return send(200, await command('status', { home, repo: identifier(url.searchParams.get('repo')), job: identifier(url.searchParams.get('job')) }));
      }
      if (request.method === 'GET' && url.pathname === '/api/evidence') {
        const repo = identifier(url.searchParams.get('repo')), job = identifier(url.searchParams.get('job')), path = url.searchParams.get('path');
        if (!/^(?:request|spec|plan|progress)\.md$|^(?:reports|attempts)\/[a-zA-Z0-9._-]+\/(?:stdout|stderr)\.log$|^reports\/[a-zA-Z0-9._-]+\.json$/.test(path)) throw error('Unsupported evidence file.');
        const absolute = await safe(home, join(home, 'jobs', repo, job, path));
        const text = await readFile(absolute, 'utf8'); return send(200, { text: text.slice(0, 200000), truncated: text.length > 200000 });
      }
      if (request.method !== 'POST') throw error('Not found.', 404);
      const received = Buffer.from(request.headers['x-cc-token'] || '');
      if (request.headers.origin !== origin || received.length !== token.length || !timingSafeEqual(received, Buffer.from(token))) throw error('Session token and same origin are required.', 403);
      const input = await body(request);
      if (url.pathname === '/api/recover') return send(200, await recoverTask(home, input.operation));
      if (url.pathname === '/api/settings') {
        if (!input.repo) {
          if (Object.keys(input).some(key => key !== 'concurrency')) throw error('Only home concurrency can be configured.');
          positive(input.concurrency, 'Home concurrency');
          return send(200, await saveGlobalSettings(home, input));
        }
        const repo = identifier(input.repo), project = await projectRecord(home, repo);
        effectiveConfig(input.settings, host);
        if (input.markdownHash !== hash(project.markdown)) throw error('Configuration changed. Reload before saving.', 409);
        try { await inspectConfig(home, repo, host); } catch (cause) { if (input.reconcile !== true) throw error(`${cause.message} Review the Markdown and explicitly reconcile before saving.`, 409); }
        try { return send(200, await configurationWrite(home, () => saveConfig(home, repo, input.settings, host, { replace: true }))); }
        catch (cause) { if (cause.code !== 'CC_CAPACITY') throw cause;
          return send(202, { pending: true, operation: await enqueue(home, { action: 'settings', repo, settings: input.settings, markdownHash: input.markdownHash }, `settings:${repo}:${hash(JSON.stringify(input))}`) }); }
      }
      if (url.pathname === '/api/prepare') {
        if (typeof input.source !== 'string' || !input.source.trim()) throw error('A repository path or GitHub URL is required.');
        const report = await prepare({ home, cwd: home, source: input.source }); const id = randomUUID();
        prepared.set(id, { report, at: Date.now() });
        let previous;
        try { const record = await projectRecord(home, report.id, { requireBase: false }); previous = { ...savedSettings(record.markdown), baseBranch: record.baseBranch === 'unknown' ? '' : record.baseBranch }; }
        catch { /* A new repository has no previous settings. */ }
        return send(200, { token: id, report, previous });
      }
      if (url.pathname === '/api/register') {
        const saved = prepared.get(input.token);
        if (!saved || Date.now() - saved.at > 30 * 60 * 1000) throw error('Prepare this repository again.');
        let result;
        try { result = await configurationWrite(home, () => register({ home, cwd: home, report: saved.report.reportPath, details: input.details, updateSettings: true })); }
        catch (cause) { if (cause.code !== 'CC_CAPACITY') throw cause;
          result = { pending: true, operation: await enqueue(home, { action: 'register', report: saved.report.reportPath, details: input.details }, `register:${input.token}`) }; }
        prepared.delete(input.token); return send(200, result);
      }
      if (url.pathname !== '/api/action') throw error('Not found.', 404);
      const { action, text } = input;
      if (!['add', 'start', 'run', 'resume', 'feedback'].includes(action)) throw error('Unsupported action.');
      if (['add', 'feedback'].includes(action) && (typeof text !== 'string' || !text.trim())) throw error('Enter a nonempty request or feedback.');
      const board = await readBoard();
      const selected = input.repo === 'all' && action === 'run' ? board.repos : board.repos.filter(repo => repo.id === input.repo);
      if (!selected.length) throw error('Select a registered repository.');
      const operations = [], errors = [];
      for (const repo of selected) {
       try {
        identifier(repo.id); const context = await projectRecord(home, repo.id, { requireBase: false });
        if (['run', 'start'].includes(action)) {
          const issues = await queueIssues(context, action === 'start' ? { issue: input.issue } : {});
          for (const issue of issues) {
            if (board.cards.some(card => card.repo === repo.id && card.issue?.number === issue.number && card.job)) continue;
            operations.push(await enqueue(home, { action: 'start', repo: repo.id, issue }, `${repo.id}:issue:${issue.number}`));
          }
        } else {
          if (['resume', 'feedback'].includes(action)) {
            identifier(input.job); const job = await loadJob(home, repo.id, input.job);
            if (job.legacy || job.stage !== 'blocked') throw error('Only a blocked enforced job can resume.');
            if (board.cards.some(card => card.repo === repo.id && card.job?.id === job.id && card.lane === 'done')) throw error('This work is already completed on GitHub.');
            if (job.interruptedStage === 'build' && job.round >= (await json(join(job.directory, 'context.json'))).config.maxRounds) throw error('Job round limit exhausted; create a successor or finish directly.');
            if (action === 'resume' && job.requiresFeedback) throw error('This job requires feedback before resuming.');
          }
          operations.push(await enqueue(home, { action, repo: repo.id, ...(input.job ? { job: input.job } : {}), ...(text ? { text } : {}) }, `${repo.id}:${input.job || hash(text)}:${action === 'add' ? 'add' : 'job'}`));
        }
       } catch (cause) {
         if (selected.length === 1) throw cause;
         errors.push({ repo: repo.id, error: cause.message });
       }
      }
      send(202, { operations, errors });
    } catch (cause) { send(cause.status || 400, { error: cause.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  let ticking = false;
  const timer = schedule ? setInterval(async () => {
    if (ticking) return; ticking = true;
    try { await dispatch(home, host); } catch (cause) { console.error(`Dashboard scheduler: ${cause.message}`); } finally { ticking = false; }
  }, 2000) : null;
  return { url: `${origin}/`, token, close: () => new Promise((resolve, reject) => { clearInterval(timer); server.close(cause => cause ? reject(cause) : resolve()); server.closeIdleConnections(); }) };
}
