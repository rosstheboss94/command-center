#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, lstat, realpath, rename, unlink, open } from 'node:fs/promises';
import { join, resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { discoverHome } from './home.mjs';
import { buildCatalog, snapshot, compareSnapshots, collectFacts, instructionScopes } from './inspection.mjs';
import { validateSkills, validateChecks, checkGaps } from './checks.mjs';
import { failure } from './errors.mjs';

const exec = promisify(execFile);
const fields = ['Purpose', 'Checkout', 'Remote', 'Repository identity', 'Base branch', 'Instructions'];
const instructionNames = new Set(['AGENTS.md', 'CLAUDE.md']);
const manifestNames = new Set(['package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'Pipfile', 'setup.cfg', 'setup.py', 'requirements.txt', 'go.mod', 'go.work', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'Makefile', 'CMakeLists.txt', 'mix.exs']);
const lockNames = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock']);
const skippedDirectories = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', '.cache', 'dist', 'build', '.worktrees']);

async function stat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function pathKey(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function contained(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

async function safePath(root, path) {
  if (!contained(root, path)) throw new Error('Path escapes the home directory.');
  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    const info = await stat(current);
    if (info?.isSymbolicLink()) throw new Error('Linked paths inside the home require a path decision.');
  }
}

function githubParts(owner, repo) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(owner) ||
      !/^[a-z0-9._-]+$/i.test(repo) || ['.', '..'].includes(repo)) {
    throw new Error('Invalid GitHub owner or repository component.');
  }
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

function remoteSource(input) {
  let owner;
  let repo;
  let ssh = false;
  if (/^https:\/\//i.test(input) || /^ssh:\/\//i.test(input)) {
    // Match the raw path so URL normalization cannot hide traversal or encoded segments.
    const match = /^(https|ssh):\/\/([^/]+)\/([^?#]*)$/i.exec(input);
    if (!match) throw new Error('Use a repository root URL without queries or fragments.');
    const protocol = match[1].toLowerCase();
    const authority = match[2];
    if ((protocol === 'https' && authority.includes('@')) || (protocol === 'ssh' && authority.toLowerCase() !== 'git@github.com')) {
      throw new Error('Credential-bearing URLs are rejected; use a clean GitHub URL or git SSH user.');
    }
    if (protocol === 'https' && authority.toLowerCase() !== 'github.com') throw new Error('Only GitHub repository URLs are supported.');
    ssh = protocol === 'ssh';
    [owner, repo] = match[3].replace(/\/+$/, '').split('/');
    if (match[3].replace(/\/+$/, '').split('/').length !== 2) throw new Error('Use a repository root URL.');
  } else {
    const match = /^(git@github\.com:)?([^/]+)\/([^/]+)\/*$/i.exec(input);
    if (!match) throw new Error('Use a documented GitHub URL, owner/repo, or an existing local path.');
    ssh = Boolean(match[1]);
    [, , owner, repo] = match;
  }
  repo = repo.replace(/\.git$/i, '');
  ({ owner, repo } = githubParts(owner, repo));
  return {
    kind: 'remote', identity: `github.com/${owner}/${repo}`, id: `${owner}--${repo}`,
    checkout: `projects/${owner}/${repo}`,
    url: ssh ? `git@github.com:${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`,
  };
}

export async function parseSource(input, cwd = process.cwd()) {
  if (typeof input !== 'string' || !input.trim() || /[\r\n\0]/.test(input)) throw new Error('A project source is required.');
  const local = resolve(cwd, input);
  if (await stat(local)) return { kind: 'local', checkout: await realpath(local) };
  return remoteSource(input);
}

async function gitRunner(args, cwd) {
  try { return { code: 0, ...await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }) }; }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Git must be installed and available on PATH.');
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

async function gitText(run, args, cwd, optional = false) {
  const result = await run(args, cwd);
  if (result.code !== 0 && !optional) throw new Error(`Git checkout inspection failed (${args[0]}).`);
  if (result.code !== 0) return null;
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}

function checkCredentials(remote) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    let url;
    try { url = new URL(remote); } catch { throw new Error('Invalid checkout remote.'); }
    if (url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) || url.search || url.hash) {
      throw new Error('Credential-bearing or ambiguous checkout remote; supply a clean origin before registration.');
    }
  } else if (remote.includes('@') && !/^git@[^:]+:[^\r\n]+$/.test(remote)) {
    throw new Error('Credential-bearing checkout remote is rejected.');
  }
}

function identityForRemote(remote) {
  if (!remote) return null;
  checkCredentials(remote);
  if (/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/i.test(remote)) return remoteSource(remote).identity;
  return null;
}

async function inspectCheckout(path, run, exactRoot = false) {
  if (!(await stat(path))) throw new Error('Recorded checkout is missing or unavailable.');
  const top = await gitText(run, ['rev-parse', '--show-toplevel'], path);
  const canonicalTop = await realpath(top);
  if (exactRoot && pathKey(canonicalTop) !== pathKey(await realpath(path))) throw new Error('Destination is not the exact Git checkout root.');
  const common = await gitText(run, ['rev-parse', '--path-format=absolute', '--git-common-dir'], canonicalTop);
  const worktrees = await gitText(run, ['worktree', 'list', '--porcelain', '-z'], canonicalTop);
  const primary = /^worktree ([^\0]+)/.exec(worktrees)?.[1];
  if (!primary) throw new Error('Cannot resolve the primary checkout.');
  const checkout = await realpath(primary);
  const remote = await gitText(run, ['remote', 'get-url', 'origin'], checkout, true);
  const identity = identityForRemote(remote) || `local:${pathKey(checkout)}`;
  const currentBranch = await gitText(run, ['symbolic-ref', '--short', 'HEAD'], checkout, true);
  const originHead = await gitText(run, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], checkout, true);
  const resolvedOriginHead = originHead && await gitText(run, ['rev-parse', '--verify', 'refs/remotes/origin/HEAD^{commit}'], checkout, true);
  const defaultBranch = resolvedOriginHead ? originHead.replace(/^origin\//, '') : null;
  const tracked = await gitText(run, ['ls-files', '-co', '--exclude-standard', '-z'], checkout);
  const paths = new Set(tracked.split('\0').filter(Boolean));
  for (const name of [...instructionNames, ...manifestNames, ...lockNames, 'README.md', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile']) {
    if ((await stat(join(checkout, name)))?.isFile()) paths.add(name);
  }
  const inspection = { instructions: [], manifests: [], lockfiles: [], ci: [], documentation: [], currentBranch, defaultBranch, defaultBranchSource: defaultBranch ? 'refs/remotes/origin/HEAD' : null };
  for (const name of [...paths].sort()) {
    const components = name.split('/');
    if (components.some(part => skippedDirectories.has(part))) continue;
    const leaf = components.at(-1);
    if (instructionNames.has(leaf)) inspection.instructions.push(name);
    if (manifestNames.has(leaf) || /\.(?:sln|csproj|fsproj)$/.test(leaf)) inspection.manifests.push(name);
    if (lockNames.has(leaf)) inspection.lockfiles.push(name);
    if (/^(?:\.github\/workflows\/.*\.ya?ml|\.circleci\/config\.yml|\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile)$/.test(name)) inspection.ci.push(name);
    if (/^(?:README(?:\.md)?|docs\/.*\.md)$/i.test(name)) inspection.documentation.push(name);
  }
  return { checkout, commonDirectory: await realpath(common), remote, identity, inspection };
}

function parseFields(text) {
  const values = {};
  for (const name of fields) {
    const matches = [...text.matchAll(new RegExp(`^- ${name} — (.*)$`, 'gm'))];
    if (matches.length > 1) throw new Error(`Ambiguous config field: ${name}.`);
    const value = matches[0]?.[1].trim();
    if (value && value !== 'unknown' && !/^<[^>]+>$/.test(value)) values[name] = value;
  }
  return values;
}

async function scanRecords(home) {
  const root = join(home, 'repos');
  if (!(await stat(root))) return [];
  await safePath(home, root);
  const records = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.isSymbolicLink()) throw new Error('Linked registry directories require a path decision.');
    if (!entry.isDirectory()) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(entry.name)) throw new Error('Invalid record ID.');
    const path = join(root, entry.name, 'config.md');
    await safePath(home, path);
    if (!(await stat(path))) throw new Error(`Incomplete config record: ${entry.name}. Inspect it before recovery.`);
    const text = await readFile(path, 'utf8');
    const values = parseFields(text);
    if (!values.Checkout) throw new Error(`Malformed config record ${entry.name}: Checkout is required.`);
    const checkout = resolve(home, values.Checkout);
    const remoteIdentity = identityForRemote(values.Remote);
    let identity = values['Repository identity'];
    const github = identity && /^github\.com\/([^/]+)\/([^/]+)$/i.exec(identity);
    if (github) {
      const parts = githubParts(github[1], github[2]);
      identity = `github.com/${parts.owner}/${parts.repo}`;
    } else if (identity && identity !== 'local-only' && !identity.startsWith('local:')) throw new Error(`Malformed identity in config ${entry.name}.`);
    if (identity?.startsWith('local:')) identity = null;
    if (identity === 'local-only') identity = null;
    if (identity && remoteIdentity && identity !== remoteIdentity) throw new Error(`Conflicting identity in config ${entry.name}.`);
    identity ||= remoteIdentity || `local:${pathKey(await stat(checkout) ? await realpath(checkout) : checkout)}`;
    if (records.some(record => record.identity === identity)) throw new Error('Duplicate repository identities in configs; resolve the ambiguous records.');
    records.push({ id: entry.name, text, checkout, identity });
  }
  return records;
}

async function withLock(homePath, action) {
  const home = await realpath(resolve(homePath));
  const control = join(home, '.cc');
  await safePath(home, control);
  await mkdir(control, { recursive: true });
  const lock = join(control, 'init.lock');
  let handle;
  try { handle = await open(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another init operation owns the lock. Inspect .cc/init.lock and its owner before recovery.');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    return await action(home);
  } finally { await handle.close(); await unlink(lock); }
}

async function atomicWrite(home, path, text) {
  await safePath(home, path);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx' });
    await rename(temporary, path);
  } finally { if (await stat(temporary)) await unlink(temporary); }
}

async function ensureIgnored(home) {
  const path = join(home, '.gitignore');
  await safePath(home, path);
  const existed = Boolean(await stat(path));
  let text = existed ? await readFile(path, 'utf8') : '';
  const rules = '/projects/\n/.cc/\n';
  if (!text.replaceAll('\r\n', '\n').endsWith(rules)) {
    text += `${text && !text.endsWith('\n') ? '\n' : ''}${rules}`;
    await atomicWrite(home, path, text);
    return existed ? 'updated' : 'created';
  }
  return false;
}

async function chooseTarget(home, source, records, run) {
  const local = source.kind === 'local' ? await inspectCheckout(source.checkout, run) : null;
  const identity = local?.identity || source.identity;
  const existing = records.find(record => record.identity === identity || local && pathKey(record.checkout) === pathKey(local.checkout));
  if (existing) {
    if (existing.identity !== identity) throw new Error('Recorded checkout identity has changed.');
    return { id: existing.id, checkout: existing.checkout, identity, existing };
  }
  const id = source.kind === 'remote' ? source.id : basename(local.checkout).toLowerCase().replaceAll(' ', '-');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error('Checkout basename cannot form a stable repo ID; choose a supported checkout name.');
  if (records.some(record => record.id.toLowerCase() === id.toLowerCase())) throw new Error('Repository ID collision; resolve existing records before proceeding.');
  const checkout = local?.checkout || join(home, source.checkout);
  return { id, checkout, identity, existing: null };
}

export async function prepare({ home, cwd = process.cwd(), source, gitRunner: run = gitRunner }) {
  const homeResolution = await discoverHome({ home, cwd });
  home = homeResolution.home;
  if (!source && pathKey(await realpath(cwd)) === pathKey(home)) throw failure('SOURCE_REQUIRED', 'Supply a project link or local path when invoking init in the home root.');
  const parsed = await parseSource(source || '.', cwd);
  return withLock(home, async homeRoot => {
    const changes = [];
    const records = await scanRecords(homeRoot);
    const target = await chooseTarget(homeRoot, parsed, records, run);
    if (parsed.kind === 'remote' && !target.existing) {
      await safePath(homeRoot, target.checkout);
      if (!(await stat(target.checkout))) {
        const ignored = await ensureIgnored(homeRoot);
        if (ignored) changes.push({ path: '.gitignore', action: ignored, fields: ['ignore rules'] });
        await mkdir(dirname(target.checkout), { recursive: true });
        const result = await run(['clone', '--', parsed.url, target.checkout], homeRoot);
        if (result.code !== 0) throw new Error('Git clone failed. The repo remains unregistered. Inspect the destination for a partial clone before retrying.');
        changes.push({ path: relative(homeRoot, target.checkout).split(sep).join('/'), action: 'created', fields: ['checkout'] });
      }
    }
    const inspected = await inspectCheckout(target.checkout, run, parsed.kind === 'remote');
    if (inspected.identity !== target.identity) throw new Error('Checkout origin identity does not match the requested repository.');
    const ignored = await ensureIgnored(homeRoot);
    if (ignored) changes.push({ path: '.gitignore', action: ignored, fields: ['ignore rules'] });
    const catalog = await buildCatalog(homeRoot);
    const beforeFacts = await snapshot(inspected.checkout, inspected.inspection, homeRoot, catalog);
    const facts = await collectFacts(inspected.checkout, inspected.inspection);
    const preparedSnapshot = await snapshot(inspected.checkout, inspected.inspection, homeRoot, catalog);
    const changedDuringInspection = compareSnapshots(beforeFacts, preparedSnapshot);
    if (changedDuringInspection.length) throw failure('INSPECTION_STALE', 'Inputs changed during inspection; prepare again.', { paths: changedDuringInspection });
    const reportPath = join(homeRoot, '.cc/init', `${randomUUID()}.json`);
    changes.push({ path: relative(homeRoot, reportPath).split(sep).join('/'), action: 'created', fields: ['inspection report'] });
    const report = { version: 2, home: homeRoot, homeResolution: { selectedBy: homeResolution.selectedBy }, id: target.id, ...inspected,
      facts, instructionScopes: instructionScopes(inspected.inspection.instructions), catalog,
      snapshot: preparedSnapshot, changes };
    await atomicWrite(homeRoot, reportPath, JSON.stringify(report, null, 2) + '\n');
    return { ...report, reportPath };
  });
}

function singleLine(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${name} must be a nonempty single-line string.`);
  return value.trim();
}

async function validateDetails(details, inspection, checkout) {
  if (!details || !Array.isArray(details.checks) || !Array.isArray(details.skills) || !Array.isArray(details.setupGaps)) throw failure('CHECK_INVALID', 'Details require checks, skills, and setupGaps arrays.');
  if (details.purpose !== undefined) singleLine(details.purpose, 'purpose');
  for (const skill of details.skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill)) throw failure('SKILL_INVALID', 'Invalid skill name.');
  }
  const sources = [...inspection.instructions, ...inspection.ci, ...inspection.manifests, ...inspection.documentation];
  for (const check of details.checks) {
    singleLine(check.command, 'command'); singleLine(check.workingDirectory, 'workingDirectory'); singleLine(check.source, 'source');
    if (!sources.includes(check.source)) throw failure('CHECK_INVALID', 'Each check source must appear in the inspection checklist.');
    const path = resolve(checkout, check.workingDirectory);
    if (!contained(checkout, path) || !contained(await realpath(checkout), await realpath(path))) throw new Error('Check workingDirectory escapes the checkout.');
    if (!(await stat(path))?.isDirectory()) throw new Error('Check workingDirectory must be a directory.');
  }
  for (const gap of details.setupGaps) singleLine(gap, 'setup gap');
}

function factualFields(report) {
  return {
    Checkout: relative(report.home, report.checkout).split(sep).join('/'),
    Remote: report.remote || 'none',
    'Repository identity': report.identity,
    'Base branch': report.inspection.defaultBranch || 'unknown',
    Instructions: report.instructionScopes.filter(item => item.kind === 'root').map(item => item.path).join(', ') || 'none found',
  };
}

async function renderConfig(report, details) {
  let text = await readFile(new URL('../assets/config.md', import.meta.url), 'utf8');
  text = text.replace('<repo-id>', report.id);
  const facts = { Purpose: details.purpose || 'unknown', ...factualFields(report) };
  for (const [name, value] of Object.entries(facts)) {
    singleLine(value, name);
    text = text.replace(new RegExp(`^- ${name} — .*$`, 'm'), () => `- ${name} — ${value}`);
  }
  const checks = details.checks.map(check => `- Command — ${check.command}\n  Working directory — ${check.workingDirectory}\n  Source — ${check.source}`).join('\n');
  const gaps = [...details.setupGaps];
  if (!details.checks.length) gaps.push('Validation commands need setup.');
  if (!report.inspection.defaultBranch) gaps.push('Default branch needs confirmation.');
  if (!details.purpose) gaps.push('Project purpose needs setup.');
  const setup = [...new Set(gaps)].map(gap => `- ${gap}`).join('\n') || 'None.';
  text = text.replace(/(## Validation\r?\n)[\s\S]*?(?=\r?\n## Engineering skills)/, (_, heading) => `${heading}\n${checks || 'No validation commands confirmed.'}\n\n## Setup gaps\n\n${setup}\n`);
  text = text.replace(/(## Engineering skills\r?\n)[\s\S]*?(?=\r?\n## Delivery)/, (_, heading) => `${heading}\n${details.skills.join(', ') || 'Use relevant shared lifecycle skills and warranted specialists.'}\n`);
  return text;
}

function repairMetadata(text, report) {
  const saved = parseFields(text);
  const missing = [];
  for (const [name, value] of Object.entries(factualFields(report))) {
    if (!saved[name]) {
      singleLine(value, name);
      const line = new RegExp(`^- ${name} — .*$`, 'm');
      if (line.test(text)) text = text.replace(line, () => `- ${name} — ${value}`);
      else missing.push(`- ${name} — ${value}`);
    }
  }
  if (missing.length) {
    if (!/^## Repository\s*$/m.test(text)) throw new Error('Config requires a Repository section before metadata can be repaired.');
    text = text.replace(/^(## Repository\s*)$/m, match => `${match}\n${missing.join('\n')}\n`);
  }
  return text;
}

function section(text, heading) {
  const start = new RegExp(`^## ${heading}[ \\t]*\\r?$`, 'm').exec(text);
  if (!start) return '';
  const rest = text.slice(start.index + start[0].length);
  const end = /^## /m.exec(rest);
  return rest.slice(0, end?.index).trim();
}

function savedSettings(text) {
  const values = parseFields(text);
  const validation = section(text, 'Validation');
  const checkPattern = /^- Command — (.+)\r?\n  Working directory — (.+)\r?\n  Source — (.+)/gm;
  const checks = [...validation.matchAll(checkPattern)]
    .map(match => ({ command: match[1].trim(), workingDirectory: match[2].trim(), source: match[3].trim() }));
  const skillsText = section(text, 'Engineering skills');
  const skills = /^[a-z0-9,\s-]+$/.test(skillsText) ? skillsText.split(/[\s,]+/).filter(Boolean) : [];
  const gapsText = section(text, 'Setup gaps');
  const setupGaps = gapsText && gapsText !== 'None.' ? gapsText.split(/\r?\n/).filter(line => line.trim()).map(line => line.replace(/^- /, '').trim()) : [];
  const remaining = validation.replace(checkPattern, '').replace('No validation commands confirmed.', '').trim();
  if (remaining) setupGaps.push('Saved validation prose requires structured check details through cc config.');
  return { purpose: values.Purpose, checks, skills, setupGaps };
}

function generatedSection(text, name, heading, value) {
  const start = `<!-- cc-init:${name}:start -->`;
  const end = `<!-- cc-init:${name}:end -->`;
  const block = `${start}\n## ${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n${end}`;
  const starts = [...text.matchAll(new RegExp(`^${start}\\r?$`, 'gm'))];
  const ends = [...text.matchAll(new RegExp(`^${end}\\r?$`, 'gm'))];
  if (!starts.length && !ends.length) return `${text.trimEnd()}\n\n${block}\n`;
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index < starts[0].index) throw failure('RECORD_INVALID', 'Malformed generated config section.');
  return text.slice(0, starts[0].index) + block + text.slice(ends[0].index + ends[0][0].length);
}

function settingsGaps(settings, inspection, facts, checks) {
  const gaps = [...settings.setupGaps, ...checkGaps(checks), ...facts.diagnostics.map(item => `${item.code} affects ${item.path}. ${item.message}`)];
  if (!settings.purpose) gaps.push('Project purpose needs setup.');
  if (!settings.checks.length) gaps.push('Validation commands need setup.');
  if (!inspection.defaultBranch) gaps.push('Default branch needs confirmation.');
  return [...new Set(gaps)];
}

export async function register({ home, cwd = process.cwd(), report: reportPath, details, gitRunner: run = gitRunner }) {
  const { home: homeRoot } = await discoverHome({ home, cwd });
  const absoluteReport = resolve(reportPath);
  if (!contained(join(homeRoot, '.cc/init'), absoluteReport)) throw new Error('Use a preparation report from this home.');
  await safePath(homeRoot, absoluteReport);
  const report = JSON.parse(await readFile(absoluteReport, 'utf8'));
  if (report.version !== 2 || !report.snapshot?.files || pathKey(report.home) !== pathKey(homeRoot) || !/^[a-z0-9][a-z0-9._-]*$/i.test(report.id)) throw failure('INSPECTION_STALE', 'Preparation report is unsupported or stale; prepare again.', { paths: [absoluteReport] });
  return withLock(homeRoot, async () => {
    const records = await scanRecords(homeRoot);
    const inspected = await inspectCheckout(report.checkout, run, true);
    if (inspected.identity !== report.identity || pathKey(inspected.commonDirectory) !== pathKey(report.commonDirectory)) throw new Error('Prepared checkout identity changed; prepare again.');
    const catalog = await buildCatalog(homeRoot);
    const currentSnapshot = await snapshot(inspected.checkout, inspected.inspection, homeRoot, catalog);
    const changedPaths = compareSnapshots(report.snapshot, currentSnapshot);
    if (changedPaths.length) throw failure('INSPECTION_STALE', 'Inspection inputs changed; prepare and inspect again.', { paths: changedPaths });
    const existing = records.find(record => record.identity === report.identity || pathKey(record.checkout) === pathKey(inspected.checkout));
    if (existing && (existing.identity !== report.identity || pathKey(existing.checkout) !== pathKey(inspected.checkout))) throw new Error('Prepared record changed; prepare again.');
    if (!existing && records.some(record => record.id.toLowerCase() === report.id.toLowerCase())) throw new Error('Repository ID collision.');
    const id = existing?.id || report.id;
    const current = { ...report, ...inspected, id, home: homeRoot,
      facts: await collectFacts(inspected.checkout, inspected.inspection), instructionScopes: instructionScopes(inspected.inspection.instructions) };
    const settings = existing ? savedSettings(existing.text) : details;
    try { await validateDetails(settings, current.inspection, current.checkout); }
    catch (error) { error.code ||= 'CHECK_INVALID'; throw error; }
    const resolvedSkills = validateSkills(settings.skills, catalog).map(({ name, path, digest }) => ({ name, path, digest }));
    const checks = validateChecks(settings.checks, current.facts, current.instructionScopes);
    const setupGaps = settingsGaps(settings, current.inspection, current.facts, checks);
    const configPath = join(homeRoot, 'repos', id, 'config.md');
    const indexPath = join(homeRoot, 'repos/index.md');
    await safePath(homeRoot, indexPath);
    const indexExisted = Boolean(await stat(indexPath));
    let index = indexExisted ? await readFile(indexPath, 'utf8') : '# Registered repositories\n';
    const link = `${id}/config.md`;
    const links = [...index.matchAll(/\]\(([^)]+)\)/g)].filter(match => match[1] === link || match[1] === `./${link}`);
    if (links.length > 1) throw new Error('Duplicate index links require inspection.');
    let text = existing ? repairMetadata(existing.text, current) : await renderConfig(current, { ...settings, setupGaps });
    const changedFields = existing ? Object.keys(factualFields(current)).filter(name => new RegExp(`^- ${name} — .*$`, 'm').exec(existing.text)?.[0] !== new RegExp(`^- ${name} — .*$`, 'm').exec(text)?.[0]) : ['Repository', 'Validation', 'Setup gaps', 'Engineering skills', 'Delivery'];
    for (const [name, heading, value] of [
      ['project-facts', 'Project facts', current.facts],
      ['instruction-scope', 'Instruction scope', current.instructionScopes],
      ['check-validation', 'Check validation', { checks, setupGaps, resolvedSkills, catalogDiagnostics: catalog.diagnostics }],
    ]) {
      const next = generatedSection(text, name, heading, value);
      if (next !== text) changedFields.push(heading);
      text = next;
    }
    const changes = [];
    const finalInspection = await inspectCheckout(current.checkout, run, true);
    const finalCatalog = await buildCatalog(homeRoot);
    const finalSnapshot = await snapshot(current.checkout, finalInspection.inspection, homeRoot, finalCatalog);
    const changedBeforeWrite = compareSnapshots(report.snapshot, finalSnapshot);
    if (changedBeforeWrite.length || finalInspection.identity !== report.identity) throw failure('INSPECTION_STALE', 'Inspection changed before saving; prepare again.', { paths: changedBeforeWrite.length ? changedBeforeWrite : ['git:identity'] });
    if (text !== existing?.text) {
      await atomicWrite(homeRoot, configPath, text);
      changes.push({ path: relative(homeRoot, configPath).split(sep).join('/'), action: existing ? 'updated' : 'created', fields: changedFields });
    }
    if (!links.length) {
      index = index.replace(/^No projects registered yet\..*\r?\n/gm, '');
      index += `${index.endsWith('\n') ? '' : '\n'}\n- [${id}](${link})\n`;
      await atomicWrite(homeRoot, indexPath, index);
      changes.push({ path: 'repos/index.md', action: indexExisted ? 'updated' : 'created', fields: [link] });
    }
    return { id, identity: current.identity, checkout: current.checkout, configPath, indexPath, reused: Boolean(existing),
      status: !existing ? 'created' : changes.length ? 'repaired' : 'reused', changes, settings: savedSettings(text), checks, setupGaps,
      validationLimits: checks.flatMap(check => check.limits), resolvedSkills, catalogDiagnostics: catalog.diagnostics };
  });
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    home: { type: 'string' }, cwd: { type: 'string' }, source: { type: 'string' }, report: { type: 'string' }, details: { type: 'string' },
  } });
  if (positionals.length !== 1) throw new Error('Use prepare [--home <home>] [--cwd <invocation-directory>] [--source <source>] or register [--home <home>] --report <file> --details <file>.');
  let result;
  if (positionals[0] === 'prepare') result = await prepare(values);
  else if (positionals[0] === 'register' && values.report && values.details) result = await register({ ...values, details: JSON.parse(await readFile(values.details, 'utf8')) });
  else throw new Error('Unknown operation or missing register inputs.');
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = String(error.message).replace(/([a-z]+:\/\/)[^\s/]*@/gi, '$1[redacted]@').replace(/\b(token|password|secret)=[^\s&]+/gi, '$1=[redacted]');
    console.error(JSON.stringify({ ok: false, code: error.code || 'INIT_FAILED', error: message, paths: error.paths, candidates: error.candidates }));
    process.exitCode = 1;
  });
}
