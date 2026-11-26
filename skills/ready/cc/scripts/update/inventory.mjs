import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists, safe, hash, json, execute } from '../factory/io.mjs';

const managed = ['skills', 'references', '.agents/skills', '.agents/references', '.claude/skills', '.claude/references', '.grok/skills', '.grok/references', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'LICENSE.agent-skills', 'UPSTREAM.md', '.gitignore'];
export async function tree(root, names) {
  const files = {};
  async function walk(rel) {
    const path = await safe(root, join(root, rel)), info = await exists(path);
    if (!info) return;
    if (info.isFile()) files[rel.replaceAll('\\', '/')] = hash(await readFile(path));
    else if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(`${rel}/${name}`);
    else throw new Error(`Unsupported inventory entry: ${rel}`);
  }
  for (const name of names) await walk(name);
  return files;
}
export const inventory = home => tree(home, managed);
export async function verifyInventory(home, expected) {
  const actual = await inventory(home);
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error('Candidate inventory changed; prepare a new candidate.');
}
export function canonical(path) {
  return path.replace(/^\.(?:agents|claude|grok)\//, '').replace(/^skills\/(?!ready\/|unready\/)([^/]+)\//, 'skills/ready/$1/');
}
// Legacy homes use their committed installation as the baseline. A discovery
// copy is generated only when its bytes match the old canonical source.
export async function customizations(home, candidate) {
  const actual = await inventory(home), target = candidate ? await inventory(candidate) : {}, changes = [], conflicts = [];
  const manifest = join(home, '.cc/install-manifest.json');
  let baseline;
  if (await exists(manifest)) baseline = (await json(manifest)).files;
  else {
    baseline = {};
    const commit = await execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: home });
    if (commit.code !== 0) throw new Error('Home has no installation manifest or committed baseline; preserve and establish its baseline before updating.');
    for (const path of Object.keys(actual)) {
      const source = path.replace(/^\.(?:agents|claude|grok)\//, '');
      const result = await execute('git', ['show', `${commit.stdout.trim()}:${source}`], { cwd: home });
      if (result.code === 0) baseline[path] = hash(result.stdout);
    }
  }
  for (const path of [...new Set([...Object.keys(baseline), ...Object.keys(actual)])].sort()) {
    if (actual[path] === baseline[path]) continue;
    const reconciled = Boolean(actual[path] && (target[path] === actual[path] || target[canonical(path)] === actual[path]));
    const change = { path, baseline: baseline[path] || null, current: actual[path] || null, reconciled };
    changes.push(change); if (!reconciled) conflicts.push(change);
  }
  return { changes, conflicts };
}
