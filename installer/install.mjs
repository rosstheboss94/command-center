import { readFile, readdir, mkdir, lstat, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const markerName = '.command-center.json';

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function collect(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path, name));
    else if (entry.isFile()) files.push([name, await readFile(path)]);
    else throw new Error(`Unexpected template link: ${path}`);
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

export async function installHome(target, selection) {
  if (!['codex', 'claude', 'both'].includes(selection)) throw new Error('Choose --agent codex, claude, or both.');
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
  } catch {
    throw new Error('Git must be installed and available on PATH.');
  }
  const destination = resolve(target);
  if (await exists(destination)) {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Destination must be a real directory.');
  }
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const markerPath = join(destination, markerName);
  let previous;
  if (await exists(markerPath)) {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Conflicting home marker.');
    previous = JSON.parse(await readFile(markerPath, 'utf8'));
    if (previous.templateVersion !== metadata.version || previous.kind !== 'command-center-home' ||
        !Array.isArray(previous.agents) || previous.agents.some(agent => !['codex', 'claude'].includes(agent))) {
      throw new Error('Existing home marker differs from this release. Preserve it and review an upgrade separately.');
    }
  }
  const chosen = selection === 'both' ? ['codex', 'claude'] : [selection];
  const agents = [...new Set([...(previous?.agents || []), ...chosen])].sort();
  const files = new Map(await collect(join(packageRoot, 'installer/template')));
  files.set('.gitignore', files.get('gitignore'));
  files.delete('gitignore');
  const skills = await collect(join(packageRoot, 'skills'));
  const references = await collect(join(packageRoot, 'references'));
  for (const [name, contents] of skills) files.set(join('skills', name), contents);
  for (const [name, contents] of references) files.set(join('references', name), contents);
  for (const name of ['LICENSE', 'LICENSE.agent-skills', 'UPSTREAM.md']) files.set(name, await readFile(join(packageRoot, name)));
  for (const agent of agents) {
    const folder = agent === 'codex' ? '.agents' : '.claude';
    for (const [name, contents] of skills) files.set(join(folder, 'skills', name), contents);
    for (const [name, contents] of references) files.set(join(folder, 'references', name), contents);
  }
  if (agents.includes('claude')) files.set('CLAUDE.md', Buffer.from('Read AGENTS.md for this home repo’s instructions.\n'));

  const pending = [];
  const conflicts = [];
  for (const [name, contents] of files) {
    const path = join(destination, name);
    await checkParents(destination, path);
    if (await exists(path)) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || !(await readFile(path)).equals(contents)) conflicts.push(name);
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
  return { destination, agents, written: pending.map(([path]) => relative(destination, path)) };
}
