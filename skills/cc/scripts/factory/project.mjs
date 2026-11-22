import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepare, parseSource } from '../init.mjs';
import { validateChecks, checkGaps } from '../checks.mjs';
import { effectiveConfig } from './model.mjs';
import { identifier, safe, json, exists, hash, atomic, lock, git, execute, inside } from './io.mjs';

export function field(markdown, name) {
  return new RegExp(`^- ${name} \\u2014 (.+)\\r?$`, 'm').exec(markdown)?.[1]?.trim();
}
export async function projectRecord(home, repo, { requireBase = true } = {}) {
  const path = await safe(home, join(home, 'repos', identifier(repo), 'config.md'));
  const markdown = await readFile(path, 'utf8');
  const checkoutField = field(markdown, 'Checkout');
  if (!checkoutField) throw new Error('Registered checkout is missing.');
  const checkout = await realpath(resolve(home, checkoutField));
  const root = await realpath(await git(['rev-parse', '--show-toplevel'], checkout));
  if (root !== checkout) throw new Error('Registered path is not the Git checkout root.');
  const identity = field(markdown, 'Repository identity');
  const remote = await execute('git', ['remote', 'get-url', 'origin'], { cwd: checkout });
  if (identity?.startsWith('github.com/')) {
    if (remote.code !== 0 || (await parseSource(remote.stdout.trim(), checkout)).identity !== identity) throw new Error('Registered checkout remote identity changed.');
    const push = await execute('git', ['remote', 'get-url', '--push', '--all', 'origin'], { cwd: checkout });
    if (push.code !== 0) throw new Error('Cannot verify the origin push destination.');
    for (const url of push.stdout.trim().split(/\r?\n/)) if ((await parseSource(url, checkout)).identity !== identity) throw new Error('Origin push destination differs from the registered repository.');
  } else if (remote.code === 0 && /^https?:|^git@|^ssh:/.test(remote.stdout.trim())) {
    throw new Error('Local repository identity changed; register its remote before proceeding.');
  }
  const baseBranch = field(markdown, 'Base branch');
  if (requireBase && (!baseBranch || baseBranch === 'unknown')) throw new Error('Confirm the base branch through cc config.');
  if (baseBranch && baseBranch !== 'unknown') await git(['check-ref-format', '--branch', baseBranch], checkout);
  return { home, repo, checkout, identity, baseBranch, markdown,
    deliveryAuthorized: markdown.includes('Start authorizes commits, pushing the job branch, and creating or updating a ready GitHub PR after checks and review pass.') };
}
export async function inspectConfig(home, repo, host) {
  const project = await projectRecord(home, repo);
  const path = await safe(home, join(home, 'repos', repo, 'factory.json'));
  const saved = await exists(path) ? await json(path) : null;
  if (saved && (saved.schemaVersion !== 1 || saved.markdownHash !== hash(project.markdown))) throw new Error('Central Markdown settings changed; reconcile them with cc config <repo> factory before starting work.');
  return { ...project, config: effectiveConfig(saved?.settings || {}, host) };
}
export async function saveConfig(home, repo, settings, host) {
  const project = await projectRecord(home, repo);
  effectiveConfig(settings, host);
  const path = await safe(home, join(home, 'repos', repo, 'factory.json'));
  return lock(`${path}.lock`, async () => {
    const prior = await exists(path) ? (await json(path)).settings : {};
    const mergeProfile = (base = {}, patch = {}) => ({ ...base, ...(patch.runner && patch.runner !== base.runner ? { model: null, executable: undefined } : {}), ...patch });
    const merged = { ...prior, ...settings, default: mergeProfile(prior.default, settings.default), roles: { ...prior.roles } };
    for (const [role, patch] of Object.entries(settings.roles || {})) merged.roles[role] = mergeProfile(prior.roles?.[role], patch);
    const effective = effectiveConfig(merged, host);
    await atomic(path, { schemaVersion: 1, markdownHash: hash(project.markdown), settings: merged });
    return effective;
  });
}
export async function loadContext(home, repo, host) {
  const context = await inspectConfig(home, repo, host);
  const report = await prepare({ home, cwd: context.checkout, source: context.checkout });
  if (report.id !== repo || report.identity !== context.identity) throw new Error('Registration no longer matches its checkout.');
  const validation = /(?:^|\n)## Validation\s*\r?\n([\s\S]*?)(?=\n## |$)/.exec(context.markdown)?.[1] || '';
  const pattern = /^- Command \u2014 (.+)\r?\n  Working directory \u2014 (.+)\r?\n  Source \u2014 (.+)\r?$/gm;
  const checks = [...validation.matchAll(pattern)].map(match => ({ command: match[1].trim(), workingDirectory: match[2].trim(), source: match[3].trim() }));
  if (!checks.length || validation.replace(pattern, '').trim()) throw new Error('Resolve central validation prose into structured checks with cc config.');
  for (const check of checks) {
    if (!report.inspection.instructions.concat(report.inspection.ci, report.inspection.manifests, report.inspection.documentation).includes(check.source)) throw new Error('Check source is not in current project evidence.');
    const working = await realpath(resolve(context.checkout, check.workingDirectory));
    if (!inside(context.checkout, working)) throw new Error('Check working directory escapes the checkout.');
  }
  const checked = validateChecks(checks, report.facts, report.instructionScopes);
  const gaps = checkGaps(checked);
  if (gaps.length) throw new Error(`Resolve validation limits before a factory job: ${gaps.join(' ')}`);
  // A shell-free check grammar; npm/other project scripts remain project-owned executable code.
  if (checks.some(check => /["';&|<>`$\r\n\0]/.test(check.command))) throw new Error('Checks require simple argument-separated commands; put compound commands in a declared project script.');
  const instructions = [];
  for (const scope of report.instructionScopes) instructions.push({ ...scope, text: await readFile(resolve(context.checkout, scope.path), 'utf8') });
  const skills = report.catalog.skills.filter(item => item.valid).map(item => ({ name: item.name, path: join(home, item.path) }));
  return { ...context, checks: checked, instructions, skills };
}
