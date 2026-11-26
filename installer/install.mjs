import { readFile, readdir, mkdir, lstat, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { projectSkills } from './projection.mjs';
import { createHash } from 'node:crypto';
import { inventory } from '../skills/ready/cc/scripts/update/inventory.mjs';
import { atomic } from '../skills/ready/cc/scripts/factory/io.mjs';
import { validateHome } from '../skills/ready/cc/scripts/home.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const markerName = '.command-center.json';
const knownAgents = ['claude', 'codex', 'grok'];
const selections = {
  codex: ['codex'],
  claude: ['claude'],
  grok: ['grok'],
  both: ['codex', 'claude'],
  all: ['codex', 'claude', 'grok'],
};
const addAgents = new Set(knownAgents);
const validatorRel = join('skills', 'cc', 'scripts', 'home.mjs');
const baselineValidatorRel = join('installer', 'baselines', '0.3.0', 'skills', 'cc', 'scripts', 'home.mjs');

function agentFolder(agent) {
  if (agent === 'codex') return '.agents';
  if (agent === 'claude') return '.claude';
  if (agent === 'grok') return '.grok';
  throw new Error(`Unknown agent: ${agent}`);
}

function sortedAgents(agents) {
  return [...new Set(agents)].sort();
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function fileInfo(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function realDirectory(info) {
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

function realFile(info) {
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

async function collect(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path, name));
    else if (entry.isFile()) files.push([name, await readFile(path)]);
    else throw new Error(`Unexpected link: ${path}`);
  }
  return files;
}

async function checkParents(destination, path) {
  let current = dirname(path);
  while (current !== destination) {
    if (await exists(current)) {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Conflicting directory: ${current}`);
    }
    current = dirname(current);
  }
}

async function packageMetadata() {
  return JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
}

async function managedFiles(agents) {
  const files = new Map(await collect(join(packageRoot, 'installer/template')));
  files.set('.gitignore', files.get('gitignore'));
  files.delete('gitignore');
  const skills = await collect(join(packageRoot, 'skills'));
  const references = await collect(join(packageRoot, 'references'));
  const projection = await projectSkills(packageRoot);
  for (const [name, contents] of skills) files.set(join('skills', name), contents);
  for (const [name, contents] of references) files.set(join('references', name), contents);
  for (const name of ['LICENSE', 'LICENSE.agent-skills', 'UPSTREAM.md']) files.set(name, await readFile(join(packageRoot, name)));
  for (const agent of agents) {
    const folder = agentFolder(agent);
    for (const [name, contents] of projection) files.set(join(folder, name), contents);
  }
  if (agents.includes('claude')) files.set('CLAUDE.md', Buffer.from('Read AGENTS.md for this home repo’s instructions.\n'));
  return files;
}

async function requireDestination(target) {
  const destination = resolve(target);
  if (await exists(destination)) {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Destination must be a real directory.');
  }
  return destination;
}

function markerError() {
  return new Error('Existing home marker differs from this release. Preserve it and review an upgrade separately.');
}

export async function installHome(target, selection) {
  if (!Object.hasOwn(selections, selection)) throw new Error('Choose --agent codex, claude, grok, both, or all.');
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
  } catch {
    throw new Error('Git must be installed and available on PATH.');
  }
  const destination = await requireDestination(target);
  if (await exists(join(destination, '.skill-migration.json')) || await exists(join(destination, '.skill-migration.lock'))) await validateHome(destination);
  const metadata = await packageMetadata();
  const markerPath = join(destination, markerName);
  let previous;
  if (await exists(markerPath)) {
    const info = await lstat(markerPath);
    if (!realFile(info)) throw new Error('Conflicting home marker.');
    try { previous = JSON.parse(await readFile(markerPath, 'utf8')); }
    catch { throw markerError(); }
    if (previous.templateVersion !== metadata.version || previous.kind !== 'command-center-home' ||
        !Array.isArray(previous.agents) || previous.agents.some(agent => !knownAgents.includes(agent))) {
      throw markerError();
    }
  }
  const agents = sortedAgents([...(previous?.agents || []), ...selections[selection]]);
  if (previous && await exists(join(destination, 'skills/cc')) && await exists(join(packageRoot, 'skills/ready/cc'))) throw new Error('Legacy flat home: use explicit --migrate-skills preview/apply or --add-agent; normal installation never migrates layouts.');
  const files = await managedFiles(agents);
  const pending = [];
  const conflicts = [];
  for (const [name, contents] of files) {
    const path = join(destination, name);
    await checkParents(destination, path);
    if (await exists(path)) {
      const info = await lstat(path);
      if (!realFile(info) || !(await readFile(path)).equals(contents)) conflicts.push(name);
    } else pending.push([path, contents]);
  }
  if (conflicts.length) throw new Error(`Existing files differ. No files changed:\n${conflicts.join('\n')}`);
  // Preflight completes before creating the destination or changing managed files.
  await mkdir(destination, { recursive: true });
  for (const [path, contents] of pending) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { flag: 'wx' });
  }
  if (!(await exists(join(destination, '.git')))) {
    execFileSync('git', ['init', destination], { stdio: 'pipe' });
  }
  const marker = JSON.stringify({ kind: 'command-center-home', schemaVersion: 1, templateVersion: metadata.version, agents }, null, 2) + '\n';
  const temporary = join(destination, `${markerName}.${process.pid}.tmp`);
  await writeFile(temporary, marker, { flag: 'wx' });
  await rename(temporary, markerPath);
  await atomic(join(destination, '.cc/install-manifest.json'), { schemaVersion: 1, files: await inventory(destination) });
  return { destination, agents, written: pending.map(([path]) => relative(destination, path)) };
}

function addAgentError(version, reason) {
  return new Error(`Add-agent requires a complete Command Center home from 0.3.0 or ${version}. ${reason}`);
}

export async function addAgent(target, agent) {
  if (!addAgents.has(agent)) throw new Error('Choose --add-agent codex, claude, or grok.');
  const metadata = await packageMetadata();
  const destination = resolve(target);
  const destinationInfo = await fileInfo(destination);
  if (!realDirectory(destinationInfo)) throw addAgentError(metadata.version, 'The destination is not a home directory.');
  await validateHome(destination);
  const markerPath = join(destination, markerName);
  const markerInfo = await fileInfo(markerPath);
  if (!realFile(markerInfo)) throw addAgentError(metadata.version, 'The home marker is missing or linked.');
  let previous;
  try { previous = JSON.parse(await readFile(markerPath, 'utf8')); }
  catch { throw addAgentError(metadata.version, 'The home marker is not valid JSON.'); }
  const supportedVersions = new Set(['0.3.0', metadata.version]);
  if (previous.kind !== 'command-center-home' || previous.schemaVersion !== 1 ||
      !supportedVersions.has(previous.templateVersion) || !Array.isArray(previous.agents) ||
      previous.agents.some(name => !knownAgents.includes(name)) ||
      new Set(previous.agents).size !== previous.agents.length) {
    throw addAgentError(metadata.version, 'The home marker is unsupported.');
  }
  const nested = await exists(join(destination, 'skills/ready/cc'));
  if (nested && await exists(join(destination, 'skills/cc'))) throw addAgentError(metadata.version, 'Conflicting flat/nested cc installations.');
  const cc = nested ? 'skills/ready/cc' : 'skills/cc';
  const canonicalValidator = join(cc, 'scripts/home.mjs');
  for (const name of ['repos', 'skills', ...(nested ? ['skills/ready'] : []), cc, 'references']) {
    if (!realDirectory(await fileInfo(join(destination, name)))) throw addAgentError(metadata.version, `Required directory is missing or linked: ${name}`);
  }
  for (const name of ['AGENTS.md', `${cc}/SKILL.md`, `${cc}/scripts/init.mjs`, canonicalValidator]) {
    if (!realFile(await fileInfo(join(destination, name)))) throw addAgentError(metadata.version, `Required file is missing or linked: ${name}`);
  }
  for (const name of previous.agents) {
    const folder = agentFolder(name);
    if (!realDirectory(await fileInfo(join(destination, folder, 'skills'))) || !realDirectory(await fileInfo(join(destination, folder, 'references')))) {
      throw addAgentError(metadata.version, `Configured agent ${name} is missing its discovery directories.`);
    }
    if (!realFile(await fileInfo(join(destination, folder, validatorRel)))) {
      throw addAgentError(metadata.version, `Configured agent ${name} is missing its home validator.`);
    }
  }

  const currentValidator = await readFile(join(packageRoot, await exists(join(packageRoot, 'skills/ready/cc')) ? 'skills/ready/cc/scripts/home.mjs' : validatorRel));
  const baselineValidator = await readFile(join(packageRoot, baselineValidatorRel));
  const projection = await projectSkills(destination);
  const nextAgents = sortedAgents([...previous.agents, agent]);
  const folder = agentFolder(agent);
  const pending = [];
  const replacements = [];
  const conflicts = [];

  async function queueCreate(rel, contents) {
    const path = join(destination, rel);
    await checkParents(destination, path);
    const info = await fileInfo(path);
    if (!info) pending.push({ path, contents });
    else if (!realFile(info) || !(await readFile(path)).equals(contents)) conflicts.push(rel);
  }

  for (const [name, contents] of projection) {
    const rel = join(folder, name);
    if (rel === join(folder, validatorRel)) continue;
    await queueCreate(rel, contents);
  }

  const legacyInventory = JSON.parse(await readFile(join(packageRoot, await exists(join(packageRoot, 'skills/ready/cc')) ? 'skills/ready/cc/assets/release-baselines/0.4.0.json' : 'skills/cc/assets/release-baselines/0.4.0.json')));
  for (const rel of [canonicalValidator, ...nextAgents.map(name => join(agentFolder(name), validatorRel))]) {
    const path = join(destination, rel);
    await checkParents(destination, path);
    const info = await fileInfo(path);
    if (!info) {
      if (rel === join(folder, validatorRel)) pending.push({ path, contents: currentValidator });
      else throw addAgentError(metadata.version, `Home validator is missing: ${rel}`);
      continue;
    }
    if (!realFile(info)) {
      conflicts.push(rel);
      continue;
    }
    const bytes = await readFile(path);
    if (bytes.equals(currentValidator)) continue;
    if (bytes.equals(baselineValidator) || createHash('sha256').update(bytes).digest('hex') === legacyInventory.packageFiles['skills/cc/scripts/home.mjs'].sha256) replacements.push({ path, contents: currentValidator });
    else conflicts.push(rel);
  }

  if (conflicts.length) throw new Error(`Existing files differ. No files changed:\n${[...new Set(conflicts)].sort().join('\n')}`);
  for (const item of pending) {
    await mkdir(dirname(item.path), { recursive: true });
    await writeFile(item.path, item.contents, { flag: 'wx' });
  }
  for (const item of replacements) {
    const temporary = `${item.path}.${process.pid}.tmp`;
    await writeFile(temporary, item.contents, { flag: 'wx' });
    await rename(temporary, item.path);
  }
  const sameAgents = previous.agents.length === nextAgents.length && previous.agents.every((name, index) => name === nextAgents[index]);
  if (!sameAgents) {
    const marker = JSON.stringify({ ...previous, agents: nextAgents }, null, 2) + '\n';
    const temporary = join(destination, `${markerName}.${process.pid}.tmp`);
    await writeFile(temporary, marker, { flag: 'wx' });
    await rename(temporary, markerPath);
  }
  return { destination, agents: nextAgents, written: [...pending, ...replacements].map(item => relative(destination, item.path)) };
}
