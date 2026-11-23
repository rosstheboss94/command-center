import { readFile, mkdir, writeFile, unlink, rmdir, lstat, readdir, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ownership } from '../skills/ready/cc/scripts/skill-policy.mjs';
import { bundledReleaseInputs } from '../skills/ready/cc/scripts/factory/release-inputs.mjs';
import { safe, exists, atomic, lock, alive } from '../skills/ready/cc/scripts/factory/io.mjs';
import { collectFiles, projectSkills, rewriteReferences } from './projection.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const journalName = '.skill-migration.json';
const backupName = '.skill-migration-backup';
const hostFolder = agent => agent === 'codex' ? '.agents' : `.${agent}`;
const recovery = 'Keep the complete home and managed backup. Finish active jobs with the original version, or create a fresh sibling home, reconcile custom skills/references explicitly, re-register projects, and start successor jobs with prior-job references. Never reuse stale approval as current evidence.';

async function bytesAt(home, path) {
  let absolute;
  try { absolute = await safe(home, join(home, path)); }
  catch (error) { throw new Error(`Unsafe migration path ${path}: ${error.message}`); }
  const info = await exists(absolute);
  if (!info) return null;
  if (!info.isFile()) throw new Error(`Expected regular file: ${path}`);
  return readFile(absolute);
}
async function jobBlockers(home) {
  const blockers = [];
  async function walk(path, prefix) {
    if (!(await exists(path))) return;
    if (prefix.startsWith('jobs/') && prefix.split('/').length === 3 && !(await exists(join(path, 'state.json')))) blockers.push(`Legacy job with unknown terminal state: ${prefix}`);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) { blockers.push(`Linked job/runner path: ${name}`); continue; }
      if (entry.isDirectory()) { if (entry.name !== 'worktrees' && entry.name !== 'release-inputs') await walk(join(path, entry.name), name); }
      else if (entry.name.endsWith('.lock') || entry.name === 'runner.json') blockers.push(`Active runner/lock: ${name}`);
      else if (entry.name === 'state.json') {
        try {
          const state = JSON.parse(await readFile(join(path, entry.name), 'utf8'));
          if (!['ready', 'rejected'].includes(state.stage)) blockers.push(`Nonterminal job: ${name} (${state.stage})`);
        } catch { blockers.push(`Unreadable job state: ${name}`); }
      }
    }
  }
  await walk(await safe(home, join(home, 'jobs')), 'jobs');
  await walk(await safe(home, join(home, '.cc/factory')), '.cc/factory');
  return blockers;
}

async function replacementFiles(marker) {
  const changes = new Map(), mapping = new Map([['references', 'references']]);
  for (const [name, owner] of Object.entries(ownership)) mapping.set(`skills/${name}`, `skills/${owner}/${name}`);
  for (const [path, bytes] of await collectFiles(sourceRoot, 'skills')) {
    const parts = path.split('/');
    const target = parts.length > 2 && ownership[parts[1]] ? `skills/${ownership[parts[1]]}/${parts.slice(1).join('/')}` : path;
    changes.set(target, rewriteReferences(bytes, path, target, mapping));
  }
  const projection = await projectSkills(sourceRoot);
  for (const agent of marker.agents) for (const [path, bytes] of projection) changes.set(`${hostFolder(agent)}/${path}`, bytes);
  changes.set('.command-center.json', Buffer.from(JSON.stringify({ ...marker, skillLayout: 'nested' }, null, 2) + '\n'));
  return changes;
}

async function preflight(home) {
  const conflicts = [], changes = new Map(), removals = [];
  const markerBytes = await bytesAt(home, '.command-center.json');
  const marker = JSON.parse(markerBytes || 'null');
  const descriptors = await bundledReleaseInputs();
  const baseline = descriptors.find(item => item.version === marker?.templateVersion);
  if (!baseline || marker?.kind !== 'command-center-home' || marker.schemaVersion !== 1 || !Array.isArray(marker.agents)
      || marker.agents.some(agent => !['codex', 'claude', 'grok'].includes(agent)) || new Set(marker.agents).size !== marker.agents.length) {
    return { conflicts: ['Unsupported or missing home version/marker: .command-center.json'], changes, removals };
  }
  const inventory = JSON.parse(await readFile(baseline.inventoryPath));
  for (const owner of new Set(Object.values(ownership))) if (await exists(await safe(home, join(home, 'skills', owner)))) conflicts.push(`Mixed layout destination: skills/${owner}`);
  const expected = new Map(Object.entries(inventory.managedFiles).filter(([, item]) => ['skill', 'reference', 'discovery'].includes(item.group) && (!item.agent || marker.agents.includes(item.agent))));
  for (const [path, item] of expected) {
    const bytes = await bytesAt(home, path);
    if (!bytes || hash(bytes) !== item.sha256 || bytes.length !== item.size) conflicts.push(`Modified or missing managed file: ${path}`);
  }
  const markerKey = [...marker.agents].sort().join(',') || 'none';
  if (hash(markerBytes) !== inventory.markers[markerKey]?.sha256) conflicts.push('Modified or unsupported marker: .command-center.json');
  for (const path of ['skills', 'references', ...['codex', 'claude', 'grok'].flatMap(agent => [`${hostFolder(agent)}/skills`, `${hostFolder(agent)}/references`])]) {
    const target = await safe(home, join(home, path));
    if (!(await exists(target))) continue;
    for (const [file] of await collectFiles(home, path)) if (!expected.has(file)) conflicts.push(`Unrecognized/mixed/customized managed path: ${file}`);
  }
  conflicts.push(...await jobBlockers(home));
  if (conflicts.length) return { version: marker.templateVersion, conflicts, changes, removals };
  for (const item of await replacementFiles(marker)) changes.set(...item);
  for (const [path, item] of expected) if (item.group === 'skill' && !changes.has(path)) removals.push(path);
  for (const path of changes.keys()) {
    await safe(home, join(home, path));
    if (!expected.has(path) && path !== '.command-center.json' && await exists(join(home, path))) conflicts.push(`Migration destination conflict: ${path}`);
  }
  return { version: marker.templateVersion, marker, conflicts, changes, removals };
}

async function validateJournal(home, journal) {
  if (journal.schemaVersion !== 1 || journal.home !== home || !Array.isArray(journal.operations) || !journal.operations.length) throw new Error('Invalid migration journal. Preserve backup and use manual recovery.');
  const descriptor = (await bundledReleaseInputs()).find(item => item.version === journal.marker?.templateVersion);
  if (!descriptor || !Array.isArray(journal.marker.agents) || journal.marker.agents.some(agent => !['codex', 'claude', 'grok'].includes(agent))) throw new Error('Unsupported journal baseline.');
  const inventory = JSON.parse(await readFile(descriptor.inventoryPath));
  const markerHash = hash(Buffer.from(JSON.stringify(journal.marker, null, 2) + '\n'));
  if (markerHash !== inventory.markers[[...journal.marker.agents].sort().join(',') || 'none']?.sha256) throw new Error('Journal marker differs from published baseline.');
  const replacements = await replacementFiles(journal.marker);
  const allowedPaths = new Set([...Object.entries(inventory.managedFiles).filter(([, item]) => ['skill', 'reference', 'discovery'].includes(item.group) && (!item.agent || journal.marker.agents.includes(item.agent))).map(([path]) => path), ...replacements.keys()]);
  for (const directory of ['skills', 'references', ...['codex', 'claude', 'grok'].flatMap(agent => [`${hostFolder(agent)}/skills`, `${hostFolder(agent)}/references`])]) {
    if (!(await exists(await safe(home, join(home, directory))))) continue;
    for (const [path] of await collectFiles(home, directory)) if (!allowedPaths.has(path)) throw new Error(`Unexpected managed contents during migration: ${path}`);
  }
  const seen = new Set();
  for (const operation of journal.operations) {
    if (typeof operation.path !== 'string' || !/^(?:skills\/|\.(?:agents|claude|grok)\/(?:skills|references)\/|\.command-center\.json$)/.test(operation.path)
        || seen.has(operation.path) || ![operation.before, operation.after].every(value => value === null || /^[a-f0-9]{64}$/.test(value))) throw new Error('Unsafe migration journal operation.');
    seen.add(operation.path);
    const old = inventory.managedFiles[operation.path];
    const expectedBefore = operation.path === '.command-center.json' ? markerHash : old && (!old.agent || journal.marker.agents.includes(old.agent)) ? old.sha256 : null;
    const expectedAfter = replacements.has(operation.path) ? hash(replacements.get(operation.path)) : null;
    if (operation.before !== expectedBefore || operation.after !== expectedAfter || (!replacements.has(operation.path) && old?.group !== 'skill')) throw new Error(`Journal operation differs from trusted inputs: ${operation.path}`);
    await safe(home, join(home, operation.path));
    for (const [side, digest] of [['before', operation.before], ['after', operation.after]]) {
      if (digest !== null) {
        const stored = await bytesAt(home, `${backupName}/${side}/${operation.path}`);
        if (!stored || hash(stored) !== digest) throw new Error(`Migration backup changed: ${side}/${operation.path}`);
      }
    }
    const current = await bytesAt(home, operation.path), digest = current === null ? null : hash(current);
    if (digest !== operation.after && (journal.complete || digest !== operation.before)) throw new Error(`Migration file changed since preparation: ${operation.path}`);
  }
  for (const path of [...replacements.keys(), ...Object.keys(inventory.managedFiles).filter(path => inventory.managedFiles[path].group === 'skill')]) {
    const old = inventory.managedFiles[path];
    const before = path === '.command-center.json' ? markerHash : old && (!old.agent || journal.marker.agents.includes(old.agent)) ? old.sha256 : null;
    const after = replacements.has(path) ? hash(replacements.get(path)) : null;
    if (before !== after && !seen.has(path)) throw new Error(`Incomplete migration journal: ${path}`);
  }
}

export async function migrateSkills(target, { apply = false, onProgress = async () => {} } = {}) {
  let ancestor = resolve(target);
  while (true) {
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Linked migration home/parent: ${ancestor}`);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const home = await realpath(resolve(target));
  const journalBytes = await bytesAt(home, journalName);
  if (journalBytes) {
    const journal = JSON.parse(journalBytes);
    await validateJournal(home, journal);
    if (journal.complete) return { destination: home, complete: true, conflicts: [], recovery, paths: [] };
    const blockers = await jobBlockers(home);
    if (blockers.length) throw new Error(blockers.join('\n'));
    if (!apply) return { destination: home, complete: false, conflicts: [], recovery: `Resume with --migrate-skills --apply. ${recovery}`, paths: journal.operations.map(item => item.path) };
  }
  let plan = null;
  if (!journalBytes) {
    try { plan = await preflight(home); }
    catch (error) { plan = { conflicts: [error.message], changes: new Map(), removals: [] }; }
  }
  const preview = { destination: home, sourceLayout: 'legacy-flat', version: plan?.version, conflicts: plan?.conflicts || [], recovery,
    paths: plan ? [...plan.changes.keys(), ...plan.removals] : [],
    moves: plan ? plan.removals.map(source => {
      const parts = source.split('/');
      return { source, destination: `skills/${ownership[parts[1]]}/${parts.slice(1).join('/')}` };
    }) : [] };
  if (!apply) return preview;
  if (preview.conflicts.length) throw new Error(`Migration refused. No files changed:\n${preview.conflicts.join('\n')}\n${recovery}`);
  const lockPath = await safe(home, join(home, '.skill-migration.lock'));
  const previousLock = await bytesAt(home, '.skill-migration.lock');
  if (previousLock) {
    const owner = JSON.parse(previousLock);
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) throw new Error('Migration lock has a live or unverifiable owner.');
    await unlink(lockPath);
  }
  return lock(lockPath, async () => {
    let journal;
    if (journalBytes) journal = JSON.parse(journalBytes);
    else {
      const fresh = await preflight(home);
      if (fresh.conflicts.length) throw new Error(`Migration inputs changed: ${fresh.conflicts.join('\n')}`);
      if (await exists(join(home, backupName))) throw new Error(`Preparation backup exists without a journal: ${backupName}. Preserve it, move it aside after inspection, then retry; managed files have not been promoted.`);
      journal = { schemaVersion: 1, home, marker: fresh.marker, complete: false, operations: [] };
      for (const path of [...new Set([...fresh.removals, ...fresh.changes.keys()])].filter(path => path !== '.command-center.json').concat('.command-center.json')) {
        const before = await bytesAt(home, path), after = fresh.changes.get(path) ?? null;
        if (before !== null && after !== null && before.equals(after)) continue;
        for (const [side, bytes] of [['before', before], ['after', after]]) if (bytes !== null) {
          const backup = await safe(home, join(home, backupName, side, path));
          await mkdir(dirname(backup), { recursive: true });
          await writeFile(backup, bytes, { flag: 'wx' });
        }
        journal.operations.push({ path, before: before === null ? null : hash(before), after: after === null ? null : hash(after) });
      }
      await atomic(join(home, journalName), journal);
    }
    await onProgress('prepared');
    const activeJobs = await jobBlockers(home);
    if (activeJobs.length) throw new Error(`Migration stopped before promotion: ${activeJobs.join('\n')}`);
    await validateJournal(home, journal);
    for (const operation of journal.operations) {
      const current = await bytesAt(home, operation.path);
      const digest = current === null ? null : hash(current);
      if (digest === operation.after) continue;
      if (digest !== operation.before) throw new Error(`Migration file changed: ${operation.path}`);
      const absolute = await safe(home, join(home, operation.path));
      if (operation.after === null) await unlink(absolute);
      else await atomic(absolute, await bytesAt(home, `${backupName}/after/${operation.path}`));
      await onProgress('promoted', operation.path);
    }
    // Remove only empty, known legacy skill directories. Unexpected content survives.
    async function emptyDirectories(path) {
      if (!(await exists(path))) return;
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await emptyDirectories(await safe(home, join(path, entry.name)));
      await rmdir(path).catch(error => { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
    }
    for (const name of Object.keys(ownership)) await emptyDirectories(await safe(home, join(home, 'skills', name)));
    journal.complete = true;
    await atomic(join(home, journalName), journal);
    return { ...preview, complete: true };
  });
}
