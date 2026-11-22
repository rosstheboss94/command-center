import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepare, register } from '../skills/cc/scripts/init.mjs';
import { discoverHome } from '../skills/cc/scripts/home.mjs';
import { applicableInstructions } from '../skills/cc/scripts/inspection.mjs';

async function write(root, path, text) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
}
async function homeAt(root) {
  await write(root, '.command-center.json', JSON.stringify({ kind: 'command-center-home', templateVersion: '0.3.0', agents: [] }));
  await write(root, 'AGENTS.md', '# Home');
  await mkdir(join(root, 'repos'), { recursive: true });
  for (const name of ['cc', 'sample']) await write(root, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Example skill\n---\n`);
  await mkdir(join(root, 'skills/cc/scripts'));
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-facts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await homeAt(home); await mkdir(project);
  execFileSync('git', ['init', '-b', 'main', project]);
  await write(project, 'AGENTS.md', '# Project\nRun npm test.');
  await write(project, 'package.json', JSON.stringify({ name: 'app', packageManager: 'npm@11.6.2', scripts: { test: 'node --test' } }));
  return { root, home, project };
}
const details = { purpose: 'Example app', checks: [{ command: 'npm test', workingDirectory: '.', source: 'AGENTS.md' }], skills: ['sample'], setupGaps: [] };

test('home discovery handles legacy markers, canonical aliases, ambiguity, and explicit selection', async t => {
  const f = await fixture(t);
  assert.equal((await discoverHome({ cwd: join(f.home, 'skills/cc'), helperDirectory: join(f.home, 'skills/cc/scripts') })).home, f.home);
  const other = join(f.root, 'other'); await homeAt(other);
  await assert.rejects(discoverHome({ cwd: other, helperDirectory: join(f.home, 'skills/cc') }), error => error.code === 'HOME_AMBIGUOUS' && error.candidates.length === 2);
  assert.equal((await discoverHome({ home: other, cwd: f.home })).home, other);
  const alias = join(f.root, 'alias');
  await symlink(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await discoverHome({ cwd: alias, helperDirectory: f.home })).home, f.home);
});

test('invalid and missing homes fail without filesystem mutations', async t => {
  const f = await fixture(t);
  const empty = join(f.root, 'empty'); await mkdir(empty);
  await assert.rejects(discoverHome({ cwd: empty, helperDirectory: empty }), { code: 'HOME_NOT_FOUND' });
  await write(empty, '.command-center.json', '{broken');
  await assert.rejects(discoverHome({ home: empty }), { code: 'HOME_INVALID' });
  assert.deepEqual(await readdir(empty), ['.command-center.json']);
});

test('prepare derives Node workspace facts, scoped instructions, and catalog evidence', async t => {
  const f = await fixture(t);
  await write(f.project, 'package.json', JSON.stringify({ name: 'root', packageManager: 'pnpm@10.0.0', workspaces: ['packages/*', '!packages/excluded'], scripts: { test: 'node --test' } }));
  await write(f.project, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  await write(f.project, 'packages/api/package.json', '{"name":"api","scripts":{"lint":"eslint ."}}');
  await write(f.project, 'packages/excluded/package.json', '{"name":"excluded"}');
  await write(f.project, 'packages/api/AGENTS.md', '# API rules');
  await write(f.project, 'installer/template/AGENTS.md', '# Template rules');
  const report = await prepare({ home: f.home, source: f.project });
  assert.equal(report.version, 2);
  const node = report.facts.projects.find(project => project.path === '.' && project.ecosystem === 'node');
  assert.equal(node.manager.name, 'pnpm');
  assert.ok(node.scripts.test.evidence.path === 'package.json');
  assert.deepEqual(node.workspace.members, ['packages/api']);
  assert.ok(report.instructionScopes.some(item => item.path === 'installer/template/AGENTS.md' && item.scope === 'installer/template'));
  assert.ok(report.catalog.skills.some(item => item.name === 'sample' && item.path === 'skills/sample/SKILL.md'));
});

test('facts cover Python, Go and Rust with evidence and unsupported diagnostics', async t => {
  const f = await fixture(t);
  await write(f.project, 'pyproject.toml', '[project]\nname="pyapp"\nrequires-python=">=3.12"\n[project.scripts]\nverify="app:verify"\n[tool.uv.workspace]\nmembers=["python/*"]\n');
  await write(f.project, 'uv.lock', 'version = 1\n');
  await write(f.project, 'python/child/pyproject.toml', '[project]\nname="child"\n');
  await write(f.project, 'go.mod', 'module example.com/app\n\ngo 1.23\n');
  await write(f.project, 'go.work', 'go 1.23\nuse (\n .\n ./go-child\n)\n');
  await write(f.project, 'go-child/go.mod', 'module example.com/child\ngo 1.23\n');
  await write(f.project, 'Cargo.toml', '[package]\nname="app"\nversion="0.1.0"\n[workspace]\nmembers=["crates/*"]\n');
  await write(f.project, 'crates/child/Cargo.toml', '[package]\nname="child"\nversion="0.1.0"\n');
  await write(f.project, 'pom.xml', '<project/>');
  const { facts } = await prepare({ home: f.home, source: f.project });
  const python = facts.projects.find(item => item.ecosystem === 'python' && item.path === '.');
  assert.equal(python.manager.name, 'uv'); assert.equal(python.scripts.verify.command, 'app:verify');
  assert.ok(facts.projects.some(item => item.ecosystem === 'go' && item.name === 'example.com/app'));
  assert.ok(facts.projects.some(item => item.ecosystem === 'rust' && item.name === 'child'));
  assert.ok(facts.diagnostics.some(item => item.code === 'UNSUPPORTED_MANIFEST' && item.path === 'pom.xml'));
});

for (const change of ['modify', 'add', 'remove', 'catalog']) {
  test(`registration rejects ${change} after preparation before config writes`, async t => {
    const f = await fixture(t);
    const report = await prepare({ home: f.home, source: f.project });
    if (change === 'modify') await write(f.project, 'package.json', '{}');
    if (change === 'add') await write(f.project, '.github/workflows/ci.yml', 'name: CI\n');
    if (change === 'remove') await rm(join(f.project, 'AGENTS.md'));
    if (change === 'catalog') await write(f.home, 'skills/sample/SKILL.md', 'changed');
    await assert.rejects(register({ home: f.home, report: report.reportPath, details }), error => error.code === 'INSPECTION_STALE' && error.paths.length > 0);
    assert.deepEqual(await readdir(join(f.home, 'repos')), []);
  });
}

test('checks resolve scripts, reject contradictions, and preserve custom checks with limits', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, source: f.project });
  for (const command of ['npm run missing', 'yarn test']) {
    await assert.rejects(register({ home: f.home, report: report.reportPath, details: { ...details, checks: [{ ...details.checks[0], command }] } }), { code: 'CHECK_INVALID' });
  }
  const result = await register({ home: f.home, report: report.reportPath, details: { ...details, checks: [{ ...details.checks[0], command: './custom-check.sh' }] } });
  assert.equal(result.status, 'created');
  assert.equal(result.checks[0].validationStatus, 'unresolved_structure');
  assert.ok(result.setupGaps.some(gap => gap.includes('custom-check')));
});

test('selected missing or ambiguous skills fail validation', async t => {
  const f = await fixture(t);
  let report = await prepare({ home: f.home, source: f.project });
  await assert.rejects(register({ home: f.home, report: report.reportPath, details: { ...details, skills: ['missing'] } }), { code: 'SKILL_INVALID' });
  await write(f.home, 'skills/duplicate/SKILL.md', '---\nname: sample\ndescription: Duplicate\n---\n');
  report = await prepare({ home: f.home, source: f.project });
  await assert.rejects(register({ home: f.home, report: report.reportPath, details }), { code: 'SKILL_INVALID' });
});

test('summaries describe effective saved settings and distinguish created, reused, repaired', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, source: f.project });
  const created = await register({ home: f.home, report: report.reportPath, details });
  assert.equal(created.status, 'created');
  assert.equal(created.checks[0].validationStatus, 'verified_structure');
  const reused = await register({ home: f.home, report: report.reportPath, details: { ...details, purpose: 'New proposal', setupGaps: ['Ignore me'] } });
  assert.equal(reused.status, 'reused'); assert.deepEqual(reused.changes, []);
  assert.equal(reused.settings.purpose, 'Example app'); assert.ok(!reused.setupGaps.includes('Ignore me'));
  await writeFile(join(f.home, 'repos/index.md'), '# Index\n');
  const repaired = await register({ home: f.home, report: report.reportPath, details });
  assert.equal(repaired.status, 'repaired');
  assert.deepEqual(repaired.changes.map(item => item.path), ['repos/index.md']);
  assert.ok((await readFile(created.configPath, 'utf8')).includes('## Instruction scope'));
});

test('root instructions precede scoped instructions and unrelated scopes do not apply', async t => {
  const f = await fixture(t);
  await write(f.project, 'CLAUDE.md', '# Root');
  await write(f.project, 'a/AGENTS.md', '# Nested');
  await write(f.project, 'installer/template/AGENTS.md', '# Template');
  const report = await prepare({ home: f.home, source: f.project });
  assert.deepEqual(applicableInstructions(report.instructionScopes, 'a').map(item => item.path), ['AGENTS.md', 'CLAUDE.md', 'a/AGENTS.md']);
});

test('Go sibling workspaces and manifest-free pnpm roots resolve within checkout', async t => {
  const f = await fixture(t);
  await write(f.project, 'tools/go.work', 'go 1.23\nuse (\n ../service\n)\nuse (\n ../second\n)\n');
  await write(f.project, 'service/go.mod', 'module example.com/service\ngo 1.23');
  await write(f.project, 'second/go.mod', 'module example.com/second\ngo 1.23');
  await write(f.project, 'web/pnpm-workspace.yaml', 'packages:\n - "apps/*"\n');
  await write(f.project, 'web/apps/ui/package.json', '{"name":"ui","scripts":{"test":"vitest"}}');
  const report = await prepare({ home: f.home, source: f.project });
  assert.deepEqual(report.facts.projects.find(item => item.manifest === 'tools/go.work').workspace.members, ['second', 'service']);
  const pnpm = report.facts.projects.find(item => item.path === 'web' && item.ecosystem === 'node');
  assert.equal(pnpm.manager.name, 'pnpm'); assert.deepEqual(pnpm.workspace.members, ['web/apps/ui']);
});

test('conflicting locks are gaps and invalid supported checks cannot bypass manager evidence', async t => {
  const f = await fixture(t);
  await write(f.project, 'yarn.lock', '# yarn lockfile v1');
  const report = await prepare({ home: f.home, source: f.project });
  assert.equal(report.facts.projects[0].manager.status, 'conflicting');
  await assert.rejects(register({ home: f.home, report: report.reportPath, details }), { code: 'CHECK_INVALID' });
  const result = await register({ home: f.home, report: report.reportPath, details: { ...details, checks: [] } });
  assert.ok(result.setupGaps.some(gap => gap.includes('MANAGER_CONFLICT')));
});

test('Pipfile.lock uses JSON and lockfile evidence stays with its ecosystem', async t => {
  const f = await fixture(t);
  await write(f.project, 'Pipfile', '[scripts]\nverify="pytest"\n');
  await write(f.project, 'Pipfile.lock', '{"_meta":{"pipfile-spec":6}}');
  const report = await prepare({ home: f.home, source: f.project });
  assert.ok(!report.facts.diagnostics.some(item => item.path === 'Pipfile.lock'));
  const node = report.facts.projects.find(item => item.ecosystem === 'node');
  assert.deepEqual(node.lockfiles, []);
});

test('custom flags remain unresolved and explicit escaped command targets are invalid', async t => {
  const f = await fixture(t);
  await write(f.project, 'go.mod', 'module example.com/app\ngo 1.23');
  await write(f.project, 'Cargo.toml', '[package]\nname="app"\nversion="0.1.0"\n');
  const report = await prepare({ home: f.home, source: f.project });
  const result = await register({ home: f.home, report: report.reportPath, details: { ...details, checks: [{ ...details.checks[0], command: 'cargo test --made-up-flag' }] } });
  assert.equal(result.checks[0].validationStatus, 'unresolved_structure');
  const other = await fixture(t);
  const prepared = await prepare({ home: other.home, source: other.project });
  await assert.rejects(register({ home: other.home, report: prepared.reportPath, details: { ...details, checks: [{ ...details.checks[0], command: 'npm --prefix ../outside run test' }] } }), { code: 'CHECK_INVALID' });
});

test('legacy notes and settings survive factual repair and summaries flag unparsed validation prose', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, source: f.project });
  const result = await register({ home: f.home, report: report.reportPath, details });
  let text = await readFile(result.configPath, 'utf8');
  text = text.replace('## Setup gaps', 'Also run our proprietary integration suite.\n\n## Setup gaps') + '\nMy user note stays.\n';
  await writeFile(result.configPath, text);
  const repeat = await register({ home: f.home, report: report.reportPath, details });
  assert.ok(repeat.setupGaps.some(gap => gap.includes('validation prose')));
  assert.match(await readFile(result.configPath, 'utf8'), /My user note stays/);
});

test('old reports require preparation and plugin caches are excluded from discovery', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, source: f.project });
  const legacy = JSON.parse(await readFile(report.reportPath)); legacy.version = 1;
  await writeFile(report.reportPath, JSON.stringify(legacy));
  await assert.rejects(register({ home: f.home, report: report.reportPath, details }), { code: 'INSPECTION_STALE' });
  const empty = join(f.root, 'empty'); await mkdir(empty);
  for (const cachePath of ['.codex/plugins/cache/example/1.0', '.claude/plugins/cache/example/1.0', '.grok/plugins/cache/example/1.0', '.grok/plugins/marketplaces/example/1.0']) {
    const cache = join(f.root, cachePath);
    await homeAt(cache);
    await assert.rejects(discoverHome({ cwd: empty, helperDirectory: cache }), { code: 'HOME_NOT_FOUND' });
  }
});

test('accepts a grok home marker', async t => {
  const f = await fixture(t);
  await write(f.home, '.command-center.json', JSON.stringify({ kind: 'command-center-home', templateVersion: '0.4.0', agents: ['grok'] }));
  assert.deepEqual((await discoverHome({ home: f.home })).marker.agents, ['grok']);
});

test('Cargo package selectors resolve from child workspace context and reject every unknown selection', async t => {
  const f = await fixture(t);
  await write(f.project, 'Cargo.toml', '[workspace]\nmembers=["crates/*"]\n');
  await write(f.project, 'crates/one/Cargo.toml', '[package]\nname="one"\nversion="0.1.0"');
  await write(f.project, 'crates/two/Cargo.toml', '[package]\nname="two"\nversion="0.1.0"');
  const report = await prepare({ home: f.home, source: f.project });
  const check = { command: 'cargo test -p one -p missing', workingDirectory: 'crates/one', source: 'Cargo.toml' };
  await assert.rejects(register({ home: f.home, report: report.reportPath, details: { ...details, checks: [check] } }), { code: 'CHECK_INVALID' });
  const result = await register({ home: f.home, report: report.reportPath, details: { ...details, checks: [{ ...check, command: 'cargo test -p two' }] } });
  assert.equal(result.checks[0].validationStatus, 'verified_structure');
  assert.equal(result.changes.find(change => change.path === 'repos/index.md').action, 'created');
});

test('Python manager contradictions are enforced even for external test tools', async t => {
  const f = await fixture(t);
  await write(f.project, 'pyproject.toml', '[project]\nname="app"\n[tool.poetry]\nname="app"\n');
  const report = await prepare({ home: f.home, source: f.project });
  await assert.rejects(register({ home: f.home, report: report.reportPath, details: { ...details, checks: [{ command: 'uv run pytest', workingDirectory: '.', source: 'pyproject.toml' }] } }), { code: 'CHECK_INVALID' });
});

test('registration rederives facts rather than trusting editable report facts', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, source: f.project });
  const edited = JSON.parse(await readFile(report.reportPath));
  edited.facts.projects[0].scripts.fabricated = { command: 'true', evidence: { path: 'package.json', field: 'scripts.fabricated' } };
  await writeFile(report.reportPath, JSON.stringify(edited));
  await assert.rejects(register({ home: f.home, report: report.reportPath, details: { ...details, checks: [{ ...details.checks[0], command: 'npm run fabricated' }] } }), { code: 'CHECK_INVALID' });
});

test('generated data can contain marker text without corrupting repeat registration', async t => {
  const f = await fixture(t);
  await write(f.project, 'package.json', JSON.stringify({ packageManager: 'npm@11.6.2', scripts: { test: 'echo "<!-- cc-init:project-facts:end -->"' } }));
  const report = await prepare({ home: f.home, source: f.project });
  await register({ home: f.home, report: report.reportPath, details });
  assert.equal((await register({ home: f.home, report: report.reportPath, details })).status, 'reused');
});

test('repeating init preserves bytes when a check has unresolved manager evidence', async t => {
  const f = await fixture(t);
  await write(f.project, 'package.json', '{"scripts":{"test":"node --test"}}');
  const report = await prepare({ home: f.home, source: f.project });
  const unordered = { ...details, checks: [{ command: 'npm test', source: 'AGENTS.md', workingDirectory: '.' }] };
  const first = await register({ home: f.home, report: report.reportPath, details: unordered });
  const before = await readFile(first.configPath, 'utf8');
  const next = await prepare({ home: f.home, source: f.project });
  const second = await register({ home: f.home, report: next.reportPath, details });
  assert.equal(await readFile(first.configPath, 'utf8'), before);
  assert.equal(second.status, 'reused');
});
