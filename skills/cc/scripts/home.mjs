import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure } from './errors.mjs';

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function validateHome(path) {
  try {
    const home = await realpath(resolve(path));
    const markerPath = join(home, '.command-center.json');
    const markerInfo = await info(markerPath);
    if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) throw new Error('Home marker is missing or linked.');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (marker.kind !== 'command-center-home' || (marker.schemaVersion !== undefined && marker.schemaVersion !== 1) ||
        typeof marker.templateVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(marker.templateVersion) ||
        !Array.isArray(marker.agents) || marker.agents.some(agent => !['claude', 'codex', 'grok'].includes(agent)) ||
        new Set(marker.agents).size !== marker.agents.length) throw new Error('Unsupported home marker.');
    for (const name of ['repos', 'skills', 'skills/cc']) {
      const entry = await info(join(home, name));
      if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error(`Required home directory is missing or linked: ${name}`);
    }
    for (const name of ['AGENTS.md', 'skills/cc/SKILL.md']) {
      const entry = await info(join(home, name));
      if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error(`Required home file is missing or linked: ${name}`);
    }
    return { home, marker };
  } catch (error) {
    throw failure('HOME_INVALID', `Invalid home at ${resolve(path)}. ${error.message}`);
  }
}

function pluginCache(path) {
  const normalized = path.replaceAll('\\', '/');
  return /\/(?:\.codex|\.claude|\.grok)\/plugins\/cache(?:\/|$)/i.test(normalized)
    || /\/\.grok\/plugins\/marketplaces(?:\/|$)/i.test(normalized);
}

export async function discoverHome({ home, cwd = process.cwd(), helperDirectory = dirname(fileURLToPath(import.meta.url)) } = {}) {
  if (home) return { ...await validateHome(home), selectedBy: 'explicit' };
  const candidates = new Map();
  for (const start of [cwd, helperDirectory]) {
    let current = await realpath(resolve(start));
    if (pluginCache(current)) continue;
    while (true) {
      if (await info(join(current, '.command-center.json'))) {
        const candidate = await validateHome(current);
        const key = process.platform === 'win32' ? candidate.home.toLowerCase() : candidate.home;
        candidates.set(key, candidate);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (!candidates.size) throw failure('HOME_NOT_FOUND', 'No home marker found. Supply --home with a valid Command Center home.');
  if (candidates.size > 1) throw failure('HOME_AMBIGUOUS', 'Multiple homes found. Select one with --home.', { candidates: [...candidates.values()].map(item => item.home).sort() });
  return { ...candidates.values().next().value, selectedBy: 'discovered' };
}
