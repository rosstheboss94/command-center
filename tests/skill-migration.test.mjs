import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { migrateSkills } from '../installer/migration.mjs';
import { collectFiles } from '../installer/projection.mjs';
import { fileURLToPath } from 'node:url';
import { inspectArchive } from '../skills/ready/cc/scripts/factory/release-inputs.mjs';
import { loadJob } from '../skills/ready/cc/scripts/factory/store.mjs';
import { createHash } from 'node:crypto';

async function fixture(t, version, agents = []) {
  const root = await mkdtemp(join(tmpdir(), 'cc-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = fileURLToPath(new URL(`fixtures/releases/${version}.tgz`, import.meta.url));
  const baseline = JSON.parse(await readFile(new URL(`../skills/ready/cc/assets/release-baselines/${version}.json`, import.meta.url)));
  assert.deepEqual(inspectArchive(await readFile(archive), baseline.package), baseline);
  execFileSync('tar', ['-xf', archive, '-C', root]);
  const home = join(root, 'home'); await mkdir(home);
  for (const [path, entry] of Object.entries(baseline.managedFiles)) {
    if (entry.agent && !agents.includes(entry.agent)) continue;
    await mkdir(join(home, path, '..'), { recursive: true });
    await writeFile(join(home, path), entry.generated ? 'Read AGENTS.md for this home repo’s instructions.\n' : await readFile(join(root, 'package', entry.source)));
  }
  await writeFile(join(home, '.command-center.json'), JSON.stringify({ kind: 'command-center-home', schemaVersion: 1, templateVersion: version, agents: [...agents].sort() }, null, 2) + '\n');
  await mkdir(join(home, 'jobs/archive'), { recursive: true });
  await writeFile(join(home, 'jobs/archive/evidence.json'), '{"frozen":"untouched"}');
  for (const [path, text] of [
    ['jobs/repo/completed/state.json', '{"stage":"ready"}'],
    ['jobs/repo/completed/context.json', '{"skillPath":"skills/cc/SKILL.md","frozenHash":"original"}'],
    ['jobs/repo/completed/reports/build.json', '{"approval":"historical"}'],
    ['repos/repo/factory.json', '{"settings":"custom"}'],
    ['.git/config', '[core]\nrepositoryformatversion = 0\n'],
    ['.git/hooks/fixture', 'unchanged hook'],
  ]) { await mkdir(join(home, path, '..'), { recursive: true }); await writeFile(join(home, path), text); }
  const frozen = {};
  for (const [file, content] of [['request.md', 'Historical request'], ['context.json', '{"skillPath":"skills/cc/SKILL.md","frozenHash":"original"}'], ['config.md', 'Historical settings']]) {
    await writeFile(join(home, 'jobs/repo/completed', file), content);
    frozen[file] = createHash('sha256').update(content).digest('hex');
  }
  await writeFile(join(home, 'jobs/repo/completed/state.json'), JSON.stringify({ schemaVersion: 1, repo: 'repo', id: 'completed', stage: 'ready', revision: 0, frozen }));
  return home;
}
for (const version of ['0.3.0', '0.4.0']) test(`${version} preview is read-only and apply preserves archived evidence`, async t => {
  const home = await fixture(t, version), before = await collectFiles(home);
  const preview = await migrateSkills(home);
  assert.deepEqual(preview.conflicts, []);
  const cli = fileURLToPath(new URL('../bin/create-command-center.mjs', import.meta.url));
  const cliPreview = JSON.parse(execFileSync(process.execPath, [cli, home, '--migrate-skills'], { encoding: 'utf8' }));
  assert.equal(cliPreview.version, version);
  assert.ok(cliPreview.moves.some(item => item.source === 'skills/cc/SKILL.md' && item.destination === 'skills/ready/cc/SKILL.md'));
  assert.deepEqual(await collectFiles(home), before);
  assert.equal(JSON.parse(execFileSync(process.execPath, [cli, home, '--migrate-skills', '--apply'], { encoding: 'utf8' })).complete, true);
  const after = await collectFiles(home);
  for (const [path, bytes] of before) if (/^(?:jobs|repos|\.git)\//.test(path)) assert.deepEqual(after.get(path), bytes, path);
  assert.ok(await readFile(join(home, 'skills/ready/cc/SKILL.md')));
  assert.equal(await readFile(join(home, 'jobs/archive/evidence.json'), 'utf8'), '{"frozen":"untouched"}');
  assert.equal((await loadJob(home, 'repo', 'completed')).stage, 'ready');
  assert.equal((await migrateSkills(home, { apply: true })).complete, true);
});
for (const version of ['0.3.0', '0.4.0']) test(`${version} migrates each configured legacy host into a working flat projection`, async t => {
  const agents = version === '0.3.0' ? ['claude', 'codex'] : ['claude', 'codex', 'grok'];
  const home = await fixture(t, version, agents);
  await migrateSkills(home, { apply: true });
  for (const agent of agents) {
    const folder = agent === 'codex' ? '.agents' : `.${agent}`;
    const result = JSON.parse(execFileSync(process.execPath, [join(home, folder, 'skills/cc/scripts/factory.mjs')], { encoding: 'utf8' }));
    assert.ok(result.operations.includes('status'));
  }
});
for (const scenario of ['missing', 'reference', 'unknown-version', 'mixed', 'active']) test(`migration rejects ${scenario} with no writes`, async t => {
  const home = await fixture(t, '0.4.0');
  if (scenario === 'missing') await rm(join(home, 'skills/cc/SKILL.md'));
  if (scenario === 'reference') await writeFile(join(home, 'references/definition-of-done.md'), 'custom reference');
  if (scenario === 'unknown-version') await writeFile(join(home, '.command-center.json'), '{"templateVersion":"9.0.0"}');
  if (scenario === 'mixed') { await mkdir(join(home, 'skills/ready/cc'), { recursive: true }); await writeFile(join(home, 'skills/ready/cc/SKILL.md'), '# Duplicate'); }
  if (scenario === 'active') await writeFile(join(home, 'jobs/repo/completed/state.json'), '{"stage":"build"}');
  const before = await collectFiles(home);
  assert.ok((await migrateSkills(home)).conflicts.length);
  await assert.rejects(migrateSkills(home, { apply: true }), /refused/);
  assert.deepEqual(await collectFiles(home), before);
});
test('linked managed paths and linked home parents are refused', async t => {
  const home = await fixture(t, '0.4.0');
  const linkedParent = join(dirname(home), 'linked-parent');
  await symlink(dirname(home), linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(migrateSkills(join(linkedParent, 'home')), /Linked.*parent/);
  const link = join(home, 'skills/cc/scripts/linked');
  await symlink(join(home, 'references'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const target = await readlink(link), marker = await readFile(join(home, '.command-center.json'));
  assert.ok((await migrateSkills(home)).conflicts.some(item => item.includes('skills/cc/scripts/linked')));
  await assert.rejects(migrateSkills(home, { apply: true }), /refused/);
  assert.equal(await readlink(link), target);
  assert.deepEqual(await readFile(join(home, '.command-center.json')), marker);
});
test('customized source fails preflight with exact path and zero writes', async t => {
  const home = await fixture(t, '0.4.0');
  await writeFile(join(home, 'skills/cc/SKILL.md'), 'custom');
  const before = await collectFiles(home);
  assert.ok((await migrateSkills(home)).conflicts.some(item => item.includes('skills/cc/SKILL.md')));
  await assert.rejects(migrateSkills(home, { apply: true }), /skills\/cc\/SKILL.md/);
  assert.deepEqual(await collectFiles(home), before);
});
for (const boundary of ['prepared', 'promoted']) test(`actual process exit at ${boundary} resumes from verified journal`, async t => {
  const home = await fixture(t, '0.4.0');
  const module = new URL('../installer/migration.mjs', import.meta.url).href;
  const script = `import { migrateSkills } from ${JSON.stringify(module)}; await migrateSkills(process.argv[1], { apply: true, onProgress(step) { if (step === process.argv[2]) process.exit(91); } });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, home, boundary], { encoding: 'utf8' });
  assert.equal(child.status, 91, child.stderr);
  assert.equal(JSON.parse(await readFile(join(home, '.skill-migration.json'))).complete, false);
  await migrateSkills(home, { apply: true });
  assert.equal(JSON.parse(await readFile(join(home, '.skill-migration.json'))).complete, true);
  assert.equal(await readFile(join(home, 'jobs/archive/evidence.json'), 'utf8'), '{"frozen":"untouched"}');
});
test('nonterminal jobs and modified interrupted files fail without further writes', async t => {
  const home = await fixture(t, '0.4.0');
  await writeFile(join(home, 'jobs/archive/state.json'), '{"stage":"blocked"}');
  assert.ok((await migrateSkills(home)).conflicts.some(item => item.includes('jobs/archive/state.json')));
  await rm(join(home, 'jobs/archive/state.json'));
  await assert.rejects(migrateSkills(home, { apply: true, onProgress: async step => {
    if (step === 'prepared') { await writeFile(join(home, 'skills/cc/SKILL.md'), 'changed after preparation'); }
  } }), /changed since preparation/);
  const before = await collectFiles(home);
  await assert.rejects(migrateSkills(home, { apply: true }), /changed since preparation/);
  assert.deepEqual(await collectFiles(home), before);
});
