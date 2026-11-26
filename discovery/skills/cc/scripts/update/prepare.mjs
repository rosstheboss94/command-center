import { mkdir, readdir, readFile, writeFile, cp, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execute, git, exists, atomic, json, hash, safe, now } from '../factory/io.mjs';
import { projectRecord, saveConfig, loadContext } from '../factory/project.mjs';
import { prepare, register } from '../init.mjs';
import { validateHome } from '../home.mjs';
import { updateRoot, updateLock, updateStatus, assertActive } from './state.mjs';
import { tree, inventory, verifyInventory, customizations } from './inventory.mjs';

export const identity = 'github.com/rosstheboss94/command-center';
export const sourceURL = 'https://github.com/rosstheboss94/command-center.git';
export async function verifySource(home, run = execute) {
  const matches = [];
  for (const entry of await readdir(join(home, 'repos'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = await safe(home, join(home, 'repos', entry.name, 'config.md'));
    if (!await exists(path)) continue;
    const text = await readFile(path, 'utf8');
    if (/^- Repository identity \u2014 github\.com\/rosstheboss94\/command-center\r?$/m.test(text)) matches.push(await projectRecord(home, entry.name));
  }
  if (matches.length !== 1) throw new Error('Register exactly one verified github.com/rosstheboss94/command-center source repository.');
  const result = await run('gh', ['repo', 'view', 'rosstheboss94/command-center', '--json', 'nameWithOwner'], { cwd: matches[0].checkout, timeoutSeconds: 30 });
  if (result.code !== 0 || JSON.parse(result.stdout).nameWithOwner?.toLowerCase() !== 'rosstheboss94/command-center') throw new Error('Cannot verify Command Center GitHub identity.');
  return matches[0];
}
export async function resolveRef(source, ref = 'main', run = execute) {
  if (typeof ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) || ref.includes('..')) throw new Error('Invalid source ref.');
  await git(['fetch', '--no-tags', 'origin', ref], source, run);
  const commit = await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], source, run);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Source did not resolve to an immutable commit.');
  return commit;
}
export async function claimDestination(destination, id, nonce) {
  await safe(dirname(destination), destination);
  const marker = join(destination, '.cc/update-candidate.json');
  if (await exists(destination)) {
    if (!await exists(marker)) throw new Error(`Destination already exists without this candidate's ownership: ${destination}`);
    const owner = await json(await safe(destination, marker));
    if (owner.id !== id || owner.nonce !== nonce) throw new Error(`Conflicting destination: ${destination}`);
  } else {
    await mkdir(destination); await atomic(marker, { id, nonce });
  }
}
export async function verifyArtifact(path, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '') || hash(await readFile(path)) !== digest) throw new Error('Package artifact digest mismatch.');
}
export async function transferConfiguration(home, destination, self, { refresh, save = saveConfig } = {}) {
  const root = await safe(home, join(home, 'repos'));
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = await safe(home, join(root, entry.name, 'config.md'));
    if (!await exists(path)) continue;
    const old = await projectRecord(home, entry.name), checkout = entry.name === self.repo ? self.checkout : old.checkout;
    const text = old.markdown.replace(/^- Checkout \u2014 .*$/m, () => `- Checkout — ${entry.name === self.repo ? relative(destination, checkout).replaceAll('\\', '/') : checkout}`);
    const target = join(destination, 'repos', entry.name, 'config.md'); await atomic(target, text);
    if (refresh) await refresh(entry.name, checkout);
    else {
      const report = await prepare({ home: destination, cwd: destination, source: checkout });
      await register({ home: destination, cwd: destination, report: report.reportPath });
    }
    const settingsPath = join(home, 'repos', entry.name, 'factory.json');
    const saved = await exists(settingsPath) ? await json(settingsPath) : null;
    if (saved && (saved.schemaVersion !== 1 || saved.markdownHash !== hash(old.markdown))) throw new Error(`Configuration fingerprint changed for ${entry.name}; reconcile before preparing.`);
    // Defaults stay advisory; explicitly selected provider and workflow choices survive.
    await save(destination, entry.name, saved?.settings || { blocking: false, concurrency: 3 }, 'codex', { replace: true });
  }
  const index = join(home, 'repos/index.md');
  if (await exists(index)) await atomic(join(destination, 'repos/index.md'), await readFile(index));
  const global = join(home, 'repos/factory.json');
  await atomic(join(destination, 'repos/factory.json'), await exists(global) ? await json(global) : { concurrency: 3 });
}
async function runRecorded(journal, directory, file, args, run) {
  const attempt = { id: randomUUID(), file, args, started: now(), pid: null };
  journal.attempts.push(attempt); await atomic(join(directory, 'journal.json'), journal);
  const result = await run(file, args, { cwd: journal.source, timeoutSeconds: 1800, onStart: async pid => {
    attempt.pid = pid; await atomic(join(directory, 'journal.json'), journal);
  } });
  await atomic(join(directory, `${attempt.id}.log`), `${result.stdout || ''}\n${result.stderr || ''}`);
  attempt.finished = now(); attempt.code = result.code; await atomic(join(directory, 'journal.json'), journal);
  if (result.code !== 0 || result.timedOut || result.oversized) throw new Error(`Update ${file} ${args.join(' ')} failed; inspect ${directory}/${attempt.id}.log`);
  return result.stdout;
}
export async function previewUpdate(home) {
  const source = await verifySource(home), state = await updateStatus(home);
  const available = await git(['ls-remote', sourceURL, 'refs/heads/main'], source.checkout);
  const commit = available.split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid main commit from verified source.');
  const installation = join(home, '.cc/installation.json');
  return { ...state, installedCommit: await exists(installation) ? (await json(installation)).commit : null, availableCommit: commit,
    source: source.identity, customizations: await customizations(home, undefined, { history: source.checkout }), proposedHome: join(dirname(home), 'command-center-home') };
}
export async function prepareUpdate(home, { ref = 'main', destination, run = execute } = {}) {
  await assertActive(home);
  return updateLock(home, 'prepare', async lock => {
    const executeChild = run;
    run = (file, args, options = {}) => executeChild(file, args, { ...options, onStart: async pid => { await lock.recordChild(pid); await options.onStart?.(pid); } });
    const root = await updateRoot(home);
    if (await exists(join(root, 'activate.lock'))) throw new Error('Factory activation is in progress.');
    if (!await exists(join(root, 'active.json'))) await atomic(join(root, 'active.json'), {
      activeHome: await realpath(home), previousHome: null, sourceCommit: null, generations: [await realpath(home)], revision: 0,
    });
    const project = await verifySource(home, run);
    // The registration identifies authority, never an issue body or caller-supplied URL.
    const resolver = join(root, 'resolver');
    if (!await exists(resolver)) await git(['clone', '--no-checkout', '--origin', 'origin', sourceURL, resolver], dirname(home), run);
    if (await git(['remote', 'get-url', 'origin'], resolver, run) !== sourceURL || await git(['remote', 'get-url', '--push', 'origin'], resolver, run) !== sourceURL) throw new Error('Update resolver source identity changed.');
    const commit = await resolveRef(resolver, ref, run), configFiles = await tree(home, ['repos']);
    const sourceInventory = await inventory(home);
    const fingerprint = hash(JSON.stringify({ home: await realpath(home), configFiles, sourceInventory }));
    const id = `${commit.slice(0, 12)}-${fingerprint.slice(0, 12)}`, directory = await safe(root, join(root, 'candidates', id));
    await mkdir(directory, { recursive: true });
    const journalPath = join(directory, 'journal.json');
    let journal = await exists(journalPath) ? await json(journalPath) : null;
    if (journal?.status === 'ready') { await validateCandidate(journal); return journal; }
    if (journal && destination && resolve(destination) !== journal.destination) throw new Error('This pinned candidate already owns another destination.');
    if (!journal) {
      const preferred = join(dirname(home), 'command-center-home');
      const target = destination ? resolve(destination) : await exists(preferred) ? `${preferred}-${id}` : preferred;
      if (dirname(target) !== dirname(resolve(home)) || target === resolve(home) || target === root) throw new Error('Candidate must be a separate sibling home.');
      journal = { schemaVersion: 1, id, nonce: randomUUID(), sourceHome: await realpath(home), destination: target,
        source: join(directory, 'source'), commit, ref, fingerprint, configFiles, sourceInventory, status: 'preparing', stage: 'source', attempts: [], created: now() };
      await atomic(journalPath, journal);
      await cp(join(home, 'repos'), join(directory, 'configuration'), { recursive: true, errorOnExist: true, force: false });
    }
    journal.status = 'preparing'; delete journal.error; await atomic(journalPath, journal);
    const step = async (file, args) => runRecorded(journal, directory, file, args, run);
    try {
      if (!await exists(journal.source)) await git(['clone', '--no-checkout', resolver, journal.source], dirname(home), run);
      await git(['remote', 'set-url', 'origin', sourceURL], journal.source, run);
      if ((await readdir(journal.source)).every(name => name === '.git')) await git(['checkout', '--detach', commit], journal.source, run);
      if (await git(['status', '--porcelain'], journal.source, run)) throw new Error('Candidate source has conflicting edits. Preserve it and prepare a new candidate.');
      await git(['checkout', '--detach', commit], journal.source, run);
      if (!journal.checked) {
        journal.stage = 'checks'; await atomic(journalPath, journal);
        await step('npm', ['ci']); await step('npm', ['run', 'build:discovery']); await step('npm', ['test']);
        journal.checked = now(); await atomic(journalPath, journal);
      }
      if (await git(['status', '--porcelain'], journal.source, run)) throw new Error('Candidate checks changed tracked source.');
      if (!journal.artifact) {
        journal.stage = 'package'; await atomic(journalPath, journal);
        const packed = JSON.parse(await step('npm', ['pack', '--json', '--pack-destination', directory]));
        if (packed.length !== 1 || !/^[a-zA-Z0-9._-]+\.tgz$/.test(packed[0].filename)) throw new Error('Unexpected npm package output.');
        journal.artifact = join(directory, packed[0].filename); journal.artifactDigest = hash(await readFile(journal.artifact));
      }
      journal.stage = 'install'; await atomic(journalPath, journal); await verifyArtifact(journal.artifact, journal.artifactDigest);
      const unpacked = join(directory, 'unpacked'); await mkdir(unpacked, { recursive: true });
      await step('tar', ['-xzf', journal.artifact, '-C', unpacked]);
      await claimDestination(journal.destination, id, journal.nonce);
      if (!journal.installed) {
        await step(process.execPath, ['--input-type=module', '-e', 'const {installHome}=await import(process.argv[1]);await installHome(process.argv[2],"all");', pathToFileURL(join(unpacked, 'package/installer/install.mjs')).href, journal.destination]);
        journal.files = await inventory(journal.destination); journal.installed = now(); await atomic(journalPath, journal);
      } else await verifyInventory(journal.destination, journal.files);
      journal.stage = 'configuration'; await atomic(journalPath, journal);
      const checkout = join(journal.destination, 'projects/rosstheboss94/command-center');
      if (!await exists(checkout)) await git(['clone', '--branch', 'main', sourceURL, checkout], dirname(home), run);
      if (await git(['remote', 'get-url', 'origin'], checkout, run) !== sourceURL) throw new Error('Managed Command Center checkout identity changed.');
      await git(['fetch', 'origin', commit], checkout, run);
      if (await git(['status', '--porcelain'], checkout, run)) throw new Error('Managed checkout contains conflicting changes.');
      await git(['checkout', '-B', 'main', commit], checkout, run);
      if (!journal.configured) {
        await transferConfiguration(home, journal.destination, { repo: project.repo, checkout });
        journal.destinationConfig = await tree(journal.destination, ['repos']); journal.configured = now(); await atomic(journalPath, journal);
      }
      journal.customizations = await customizations(home, journal.destination, { history: journal.source });
      await atomic(join(directory, 'customizations.json'), journal.customizations);
      await atomic(join(journal.destination, '.cc/installation.json'), { commit, artifactDigest: journal.artifactDigest, candidate: id, previousHome: home });
      journal.stage = 'validation'; await atomic(journalPath, journal);
      await validateCandidate(journal);
      journal.validation = { passed: true, at: now(), checks: ['source tests', 'packed install', 'artifact integrity', 'configuration transfer', 'discovery parity', 'local dashboard/API smoke'] };
      journal.status = 'ready'; journal.stage = 'ready'; await atomic(journalPath, journal); return journal;
    } catch (error) {
      journal.status = 'failed'; journal.error = error.message; journal.failed = now(); await atomic(journalPath, journal); throw error;
    }
  });
}
export async function validateCandidate(journal) {
  await verifyArtifact(journal.artifact, journal.artifactDigest);
  await validateHome(journal.destination); await verifyInventory(journal.destination, journal.files);
  if (JSON.stringify(await tree(journal.sourceHome, ['repos'])) !== JSON.stringify(journal.configFiles)) throw new Error('Source configuration changed; prepare a new candidate.');
  if (JSON.stringify(await inventory(journal.sourceHome)) !== JSON.stringify(journal.sourceInventory)) throw new Error('Source customizations changed; prepare a new candidate.');
  if (JSON.stringify(await tree(journal.destination, ['repos'])) !== JSON.stringify(journal.destinationConfig)) throw new Error('Candidate configuration changed; prepare a new candidate.');
  const changes = await customizations(journal.sourceHome, journal.destination, { history: journal.source });
  if (changes.conflicts.length) throw new Error(`Customization conflicts must be reconciled into source: ${changes.conflicts.map(item => item.path).join(', ')}. Both versions are preserved.`);
  for (const entry of await readdir(join(journal.destination, 'repos'), { withFileTypes: true })) if (entry.isDirectory()) {
    if (await exists(join(journal.destination, 'repos', entry.name, 'config.md'))) await loadContext(journal.destination, entry.name, 'codex');
  }
  const { projectSkills } = await import(pathToFileURL(join(dirname(journal.artifact), 'unpacked/package/installer/projection.mjs')).href);
  const projected = await projectSkills(journal.destination);
  for (const folder of ['.agents', '.claude', '.grok']) for (const [path, bytes] of projected) {
    if (!(await readFile(join(journal.destination, folder, path))).equals(bytes)) throw new Error(`Stale ${folder} discovery copy: ${path}`);
  }
  const { startDashboard } = await import(pathToFileURL(join(journal.destination, 'skills/ready/cc/scripts/dashboard/server.mjs')).href);
  const app = await startDashboard({ home: journal.destination, host: 'codex', port: 0, schedule: false,
    readBoard: async () => ({ repos: [], cards: [], sources: [] }) });
  try {
    for (const path of ['', 'api/board', 'api/settings']) {
      const response = await fetch(new URL(path, app.url)); if (!response.ok) throw new Error(`Candidate dashboard smoke failed: ${path}`); await response.text();
    }
  } finally { await app.close(); }
}
