import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm, access, cp } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { addAgent, installHome } from '../installer/install.mjs';
import { projectSkills } from '../installer/projection.mjs';
import { buildCatalog } from '../skills/ready/cc/scripts/inspection.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function verifySkills(home, folder) {
  const skills = join(home, folder, 'skills');
  const canonical = folder === '.';
  if (canonical) assert.equal((await buildCatalog(home)).skills.length, 27);
  else assert.equal((await readdir(skills)).length, 27);
  const cc = canonical ? 'ready/cc' : 'cc';
  await access(join(skills, cc, 'scripts/init.mjs'));
  await access(join(skills, cc, 'scripts/vendor/parsers.mjs'));
  await access(join(skills, cc, 'scripts/vendor/LICENSE.parsers.txt'));
  await access(join(skills, cc, 'scripts/dashboard/public/index.html'));
  await access(join(skills, cc, 'scripts/dashboard/public/app.mjs'));
  await access(join(skills, cc, 'scripts/dashboard/worker.mjs'));
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.md')) {
        const text = await readFile(path, 'utf8');
        for (const match of text.matchAll(/(?:\.\.\/)+references\/[a-z0-9-]+\.md/g)) {
          await access(resolve(dirname(path), match[0]));
        }
        for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
          if (/^(?:https?:|mailto:)/.test(match[1]) || /[<>\s]/.test(match[1])) continue;
          await access(resolve(dirname(path), match[1]));
        }
      }
    }
  }
  await walk(skills);
}

const selectionFolders = {
  codex: ['.agents'],
  claude: ['.claude'],
  grok: ['.grok'],
  both: ['.agents', '.claude'],
  all: ['.agents', '.claude', '.grok'],
};
const selectionAgents = {
  codex: ['codex'],
  claude: ['claude'],
  grok: ['grok'],
  both: ['claude', 'codex'],
  all: ['claude', 'codex', 'grok'],
};

async function localProject(root) {
  const project = join(root, 'local project');
  await mkdir(project);
  execFileSync('git', ['init', '-b', 'main', project]);
  await writeFile(join(project, 'README.md'), 'fixture\n');
  return project;
}

async function assertHelper(helper, project) {
  const prepared = JSON.parse(execFileSync(process.execPath, [helper, 'prepare', '--cwd', project, '--source', project], { encoding: 'utf8' }));
  assert.equal(prepared.ok, true);
  assert.equal(prepared.catalog.skills.length, 27);
  assert.ok(prepared.catalog.skills.some(skill => skill.name === 'cc' && skill.valid && skill.workflowStep === 'ready' && skill.path === (skill.layout === 'nested' ? 'skills/ready/cc/SKILL.md' : 'skills/cc/SKILL.md')));
  const factory = resolve(dirname(helper), 'factory.mjs');
  await access(resolve(dirname(helper), '../references/factory-roles.md'));
  const operations = JSON.parse(execFileSync(process.execPath, [factory], { encoding: 'utf8' }));
  assert.ok(operations.operations.includes('run'));
  assert.ok(operations.operations.includes('release-inputs'));
  assert.ok(operations.operations.includes('dashboard'));
  const pins = JSON.parse(await readFile(resolve(dirname(helper), '../assets/release-baselines/pins.json'), 'utf8'));
  assert.deepEqual(pins.releases.map(item => item.version), ['0.3.0', '0.4.0']);
  for (const pin of pins.releases) await access(resolve(dirname(helper), `../assets/release-baselines/${pin.version}.json`));
  const status = JSON.parse(execFileSync(process.execPath, [factory, 'status', '--home', prepared.home], { encoding: 'utf8' }));
  assert.equal(status.ok, true);
  assert.deepEqual(status.result, []);
  return prepared;
}

for (const agent of ['codex', 'claude', 'grok', 'both', 'all']) {
  test(`installs ${agent} skills with resolving references`, async t => {
    const root = await fixture(t);
    const home = join(root, 'home with spaces');
    await installHome(home, agent);
    await verifySkills(home, '.');
    for (const folder of selectionFolders[agent]) await verifySkills(home, folder);
    for (const folder of ['.agents', '.claude', '.grok']) {
      if (!selectionFolders[agent].includes(folder)) await assert.rejects(access(join(home, folder)));
    }
    if (selectionFolders[agent].includes('.claude')) assert.match(await readFile(join(home, 'CLAUDE.md'), 'utf8'), /AGENTS.md/);
    else await assert.rejects(access(join(home, 'CLAUDE.md')));
    await assert.rejects(access(join(home, 'GROK.md')));
    await access(join(home, 'AGENTS.md'));
    await access(join(home, '.git'));
    await access(join(home, 'LICENSE.agent-skills'));
    await access(join(home, 'LICENSE'));
    const ignored = execFileSync('git', ['-C', home, 'check-ignore', 'projects/owner/repo/file'], { encoding: 'utf8' });
    assert.match(ignored, /projects\/owner\/repo\/file/);
    const marker = JSON.parse(await readFile(join(home, '.command-center.json')));
    assert.equal(marker.templateVersion, '0.4.0');
    assert.equal(marker.schemaVersion, 1);
    assert.deepEqual(marker.agents, selectionAgents[agent]);
    const names = await readdir(home);
    assert.ok(!names.includes('installer') && !names.includes('bin') && !names.includes('package.json') && !names.includes('node_modules'));
    const project = await localProject(root);
    await assertHelper(join(home, 'skills/ready/cc/scripts/init.mjs'), project);
    for (const folder of selectionFolders[agent]) await assertHelper(join(home, folder, 'skills/cc/scripts/init.mjs'), project);
  });
}

test('repeat and interrupted installs preserve configuration and user records', async t => {
  const root = await fixture(t);
  const home = join(root, 'home');
  await installHome(home, 'codex');
  await mkdir(join(home, 'repos/custom'));
  await writeFile(join(home, 'repos/custom/config.md'), 'chosen settings');
  const missing = join(home, 'skills/ready/cc/assets/config.md');
  await rm(missing);
  await installHome(home, 'codex');
  await access(missing);
  assert.equal(await readFile(join(home, 'repos/custom/config.md'), 'utf8'), 'chosen settings');
  assert.deepEqual((await installHome(home, 'codex')).written, []);
  await installHome(home, 'claude');
  assert.deepEqual(JSON.parse(await readFile(join(home, '.command-center.json'))).agents, ['claude', 'codex']);
  await installHome(home, 'grok');
  assert.deepEqual(JSON.parse(await readFile(join(home, '.command-center.json'))).agents, ['claude', 'codex', 'grok']);
  await verifySkills(home, '.grok');
});

test('conflicting files cause no writes', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'AGENTS.md'), 'my instructions');
  const before = await readdir(root);
  await assert.rejects(installHome(root, 'both'), /Existing files differ/);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'my instructions');
});

const baselineValidator = await readFile(new URL('../installer/baselines/0.3.0/skills/cc/scripts/home.mjs', import.meta.url));
const currentValidator = await readFile(new URL('../skills/ready/cc/scripts/home.mjs', import.meta.url));
assert.ok(!baselineValidator.equals(currentValidator));

function discoveryFolder(agent) {
  return agent === 'codex' ? '.agents' : agent === 'claude' ? '.claude' : '.grok';
}

async function installedHome(t, agent) {
  const root = await fixture(t);
  const home = join(root, 'home');
  await installHome(home, agent);
  return { root, home };
}

async function asLegacyHome(home, version, agents) {
  const projection = await projectSkills(home);
  await rm(join(home, 'skills'), { recursive: true });
  for (const [path, bytes] of projection) if (path.startsWith('skills/')) {
    await mkdir(dirname(join(home, path)), { recursive: true });
    await writeFile(join(home, path), bytes);
  }
  const marker = JSON.parse(await readFile(join(home, '.command-center.json'), 'utf8'));
  marker.templateVersion = version;
  marker.agents = agents;
  const text = JSON.stringify(marker, null, 2) + '\n';
  await writeFile(join(home, '.command-center.json'), text);
  for (const rel of ['skills/cc/scripts/home.mjs', ...agents.map(agent => join(discoveryFolder(agent), 'skills/cc/scripts/home.mjs'))]) {
    await writeFile(join(home, rel), baselineValidator);
  }
  return text;
}

test('adds grok to 0.3.0 homes and preserves custom canonical skills', async t => {
  for (const agent of ['codex', 'claude', 'both']) {
    const { root, home } = await installedHome(t, agent);
    const agents = selectionAgents[agent];
    await asLegacyHome(home, '0.3.0', agents);
    await writeFile(join(home, 'README.md'), 'custom readme\n');
    const customSkill = `${await readFile(join(home, 'skills/idea-refine/SKILL.md'), 'utf8')}\nHome-specific customization.\n`;
    await writeFile(join(home, 'skills/idea-refine/SKILL.md'), customSkill);
    await writeFile(join(home, 'repos/note.md'), 'keep\n');
    const project = await localProject(root);
    await addAgent(home, 'grok');
    const marker = JSON.parse(await readFile(join(home, '.command-center.json'), 'utf8'));
    assert.equal(marker.templateVersion, '0.3.0');
    assert.deepEqual(marker.agents, [...agents, 'grok'].sort());
    await verifySkills(home, '.grok');
    assert.equal(await readFile(join(home, '.grok/skills/idea-refine/SKILL.md'), 'utf8'), customSkill);
    assert.notEqual(await readFile(join(home, join(discoveryFolder(agents[0]), 'skills/idea-refine/SKILL.md')), 'utf8'), customSkill);
    assert.equal(await readFile(join(home, 'README.md'), 'utf8'), 'custom readme\n');
    assert.equal(await readFile(join(home, 'repos/note.md'), 'utf8'), 'keep\n');
    for (const rel of ['skills/cc/scripts/home.mjs', ...marker.agents.map(name => join(discoveryFolder(name), 'skills/cc/scripts/home.mjs'))]) {
      assert.deepEqual(await readFile(join(home, rel)), currentValidator);
    }
    const markerBytes = await readFile(join(home, '.command-center.json'));
    assert.deepEqual((await addAgent(home, 'grok')).written, []);
    assert.deepEqual(await readFile(join(home, '.command-center.json')), markerBytes);
    for (const name of marker.agents) await assertHelper(join(home, discoveryFolder(name), 'skills/cc/scripts/init.mjs'), project);
  }
});

test('interrupted grok addition resumes from matching files', async t => {
  const { home } = await installedHome(t, 'codex');
  await asLegacyHome(home, '0.3.0', ['codex']);
  const skill = await readFile(join(home, 'skills/cc/SKILL.md'));
  const reference = await readFile(join(home, 'references/definition-of-done.md'));
  await mkdir(join(home, '.grok/skills/cc/scripts'), { recursive: true });
  await mkdir(join(home, '.grok/references'), { recursive: true });
  await writeFile(join(home, '.grok/skills/cc/SKILL.md'), skill);
  await writeFile(join(home, '.grok/skills/cc/scripts/home.mjs'), currentValidator);
  await writeFile(join(home, '.grok/references/definition-of-done.md'), reference);
  await addAgent(home, 'grok');
  await verifySkills(home, '.grok');
  assert.deepEqual(await readFile(join(home, '.grok/skills/cc/SKILL.md')), skill);
  assert.deepEqual(await readFile(join(home, '.grok/references/definition-of-done.md')), reference);
  const marker = JSON.parse(await readFile(join(home, '.command-center.json'), 'utf8'));
  assert.equal(marker.templateVersion, '0.3.0');
  assert.deepEqual(marker.agents, ['codex', 'grok']);
});

test('add-agent accepts current validators and replaces baseline copies', async t => {
  const { home } = await installedHome(t, 'both');
  await asLegacyHome(home, '0.3.0', ['claude', 'codex']);
  await writeFile(join(home, 'skills/cc/scripts/home.mjs'), currentValidator);
  await writeFile(join(home, '.agents/skills/cc/scripts/home.mjs'), currentValidator);
  await addAgent(home, 'grok');
  for (const rel of ['skills/cc/scripts/home.mjs', '.agents/skills/cc/scripts/home.mjs', '.claude/skills/cc/scripts/home.mjs', '.grok/skills/cc/scripts/home.mjs']) {
    assert.deepEqual(await readFile(join(home, rel)), currentValidator);
  }
  assert.equal(JSON.parse(await readFile(join(home, '.command-center.json'), 'utf8')).templateVersion, '0.3.0');
});

test('add-agent copies canonical customizations for claude on a current grok home', async t => {
  const { home } = await installedHome(t, 'grok');
  const customized = (await readFile(join(home, 'skills/intake/idea-refine/SKILL.md'), 'utf8')) + '\nkept customization\n';
  await writeFile(join(home, 'skills/intake/idea-refine/SKILL.md'), customized);
  const result = await addAgent(home, 'claude');
  assert.deepEqual(result.agents, ['claude', 'grok']);
  assert.equal(JSON.parse(await readFile(join(home, '.command-center.json'), 'utf8')).templateVersion, '0.4.0');
  assert.match(await readFile(join(home, '.claude/skills/idea-refine/SKILL.md'), 'utf8'), /kept customization/);
  assert.equal(await readFile(join(home, 'skills/intake/idea-refine/SKILL.md'), 'utf8'), customized);
  await verifySkills(home, '.claude');
  await assert.rejects(access(join(home, 'CLAUDE.md')));
});

test('customized compatibility files and differing destinations cause no writes', async t => {
  const { home } = await installedHome(t, 'both');
  const markerText = await asLegacyHome(home, '0.3.0', ['claude', 'codex']);
  await writeFile(join(home, '.claude/skills/cc/scripts/home.mjs'), 'custom validator\n');
  await assert.rejects(addAgent(home, 'grok'), /Existing files differ[\s\S]*\.claude[\\/]skills[\\/]cc[\\/]scripts[\\/]home\.mjs/);
  await assert.rejects(access(join(home, '.grok')));
  assert.equal(await readFile(join(home, '.command-center.json'), 'utf8'), markerText);
  assert.deepEqual(await readFile(join(home, 'skills/cc/scripts/home.mjs')), baselineValidator);
  assert.equal(await readFile(join(home, '.claude/skills/cc/scripts/home.mjs'), 'utf8'), 'custom validator\n');

  const canonical = await installedHome(t, 'codex');
  const canonicalMarker = await asLegacyHome(canonical.home, '0.3.0', ['codex']);
  await writeFile(join(canonical.home, 'skills/cc/scripts/home.mjs'), 'edited helper\n');
  await assert.rejects(addAgent(canonical.home, 'grok'), /Existing files differ[\s\S]*skills[\\/]cc[\\/]scripts[\\/]home\.mjs/);
  await assert.rejects(access(join(canonical.home, '.grok')));
  assert.equal(await readFile(join(canonical.home, '.command-center.json'), 'utf8'), canonicalMarker);
  assert.deepEqual(await readFile(join(canonical.home, '.agents/skills/cc/scripts/home.mjs')), baselineValidator);

  const other = await installedHome(t, 'codex');
  const otherMarker = await asLegacyHome(other.home, '0.3.0', ['codex']);
  await mkdir(join(other.home, '.grok/skills/cc'), { recursive: true });
  await writeFile(join(other.home, '.grok/skills/cc/SKILL.md'), 'different skill\n');
  await assert.rejects(addAgent(other.home, 'grok'), /Existing files differ[\s\S]*\.grok[\\/]skills[\\/]cc[\\/]SKILL\.md/);
  assert.equal(await readFile(join(other.home, '.command-center.json'), 'utf8'), otherMarker);
  assert.deepEqual(await readFile(join(other.home, 'skills/cc/scripts/home.mjs')), baselineValidator);
  assert.deepEqual(await readdir(join(other.home, '.grok/skills/cc')), ['SKILL.md']);
});

test('add-agent installs grok as the first agent on a home that lists none', async t => {
  const { home } = await installedHome(t, 'codex');
  const markerText = await asLegacyHome(home, '0.3.0', []);
  await addAgent(home, 'grok');
  const marker = JSON.parse(await readFile(join(home, '.command-center.json'), 'utf8'));
  assert.equal(marker.templateVersion, '0.3.0');
  assert.deepEqual(marker.agents, ['grok']);
  await verifySkills(home, '.grok');
  for (const rel of ['skills/cc/scripts/home.mjs', '.grok/skills/cc/scripts/home.mjs']) {
    assert.deepEqual(await readFile(join(home, rel)), currentValidator);
  }
  assert.deepEqual((await addAgent(home, 'grok')).written, []);
  await rm(join(home, 'references'), { recursive: true });
  await writeFile(join(home, '.command-center.json'), markerText);
  await assert.rejects(addAgent(home, 'grok'), /references/);
  assert.equal(await readFile(join(home, '.command-center.json'), 'utf8'), markerText);
});

test('add-agent rejects invalid selections and unsupported homes before writing', async t => {
  const root = await fixture(t);
  await assert.rejects(addAgent(root, 'both'), /--add-agent/);
  await assert.rejects(addAgent(root, 'all'), /--add-agent/);
  await assert.rejects(addAgent(root, ''), /--add-agent/);
  assert.deepEqual(await readdir(root), []);
  const { home } = await installedHome(t, 'codex');
  const legacy = await asLegacyHome(home, '0.2.0', ['codex']);
  await assert.rejects(addAgent(home, 'grok'), /0\.3\.0/);
  await assert.rejects(access(join(home, '.grok')));
  assert.equal(await readFile(join(home, '.command-center.json'), 'utf8'), legacy);
  const broken = JSON.parse(legacy);
  broken.kind = 'other';
  const bad = JSON.stringify(broken, null, 2) + '\n';
  await writeFile(join(home, '.command-center.json'), bad);
  await assert.rejects(addAgent(home, 'grok'), /unsupported/i);
  assert.equal(await readFile(join(home, '.command-center.json'), 'utf8'), bad);
  const cli = join(source, 'bin/create-command-center.mjs');
  const combined = spawnSync(process.execPath, [cli, home, '--agent', 'codex', '--add-agent', 'grok'], { encoding: 'utf8' });
  assert.equal(combined.status, 1);
  assert.match(combined.stderr, /Do not combine --add-agent with --agent/);
  assert.equal(await readFile(join(home, '.command-center.json'), 'utf8'), bad);
});

test('ordinary installation does not upgrade a 0.3.0 home', async t => {
  const { home } = await installedHome(t, 'codex');
  const markerText = await asLegacyHome(home, '0.3.0', ['codex']);
  await assert.rejects(installHome(home, 'grok'), /marker differs/);
  await assert.rejects(access(join(home, '.grok')));
  assert.equal(await readFile(join(home, '.command-center.json'), 'utf8'), markerText);
  assert.deepEqual(await readFile(join(home, 'skills/cc/scripts/home.mjs')), baselineValidator);
});

test('invalid agent and marker are rejected before installation', async t => {
  const root = await fixture(t);
  await assert.rejects(installHome(root, 'other'), /Choose --agent/);
  await writeFile(join(root, '.command-center.json'), '{"kind":"other"}');
  await assert.rejects(installHome(root, 'codex'), /marker differs/);
  assert.deepEqual(await readdir(root), ['.command-center.json']);
});

test('packed npm executable creates a complete home offline', async t => {
  const root = await fixture(t);
  assert.ok(process.env.npm_execpath, 'Run the tests using npm test');
  const isolated = join(root, 'package source');
  await mkdir(isolated);
  for (const name of ['package.json', 'package-lock.json', 'bin', 'installer', 'skills', 'references', 'discovery', '.codex-plugin', 'LICENSE', 'LICENSE.agent-skills', 'UPSTREAM.md', 'README.md', 'RELEASING.md', 'node_modules']) {
    await cp(join(source, name), join(isolated, name), { recursive: true });
  }
  const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: isolated, encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_cache: join(root, 'npm-cache') },
  });
  const packed = JSON.parse(npm('pack', '--json', '--pack-destination', root));
  const help = npm('exec', '--offline', '--yes', `--package=${join(root, packed[0].filename)}`, '--', 'command-center-dashboard', '--help');
  assert.match(help, /Usage: command-center-dashboard/);
  const tarball = join(root, packed[0].filename);
  const shipped = packed[0].files.map(file => file.path);
  assert.ok(shipped.includes('skills/ready/cc/scripts/skill-policy.mjs'));
  assert.ok(shipped.includes('discovery/skills/cc/SKILL.md'));
  assert.ok(shipped.includes('installer/template/gitignore'));
  assert.ok(shipped.includes('installer/baselines/0.3.0/skills/cc/scripts/home.mjs'));
  assert.ok(shipped.every(path => !path.startsWith('tests/') && !path.startsWith('jobs/') && !path.startsWith('projects/')));
  for (const agent of ['codex', 'claude', 'all']) {
    const home = join(root, `packed-${agent}`);
    npm('exec', '--offline', '--yes', `--package=${tarball}`, '--', 'create-command-center', home, '--agent', agent);
    await verifySkills(home, '.');
    for (const folder of selectionFolders[agent]) await verifySkills(home, folder);
  }
  const destination = join(root, 'installed home');
  const output = npm('exec', '--offline', '--yes', `--package=${tarball}`, '--', 'create-command-center', destination, '--agent', 'both');
  assert.match(output, /Command Center installed/);
  await verifySkills(destination, '.agents');
  await verifySkills(destination, '.claude');
  await access(join(destination, '.gitignore'));
  const project = join(root, 'local fixture');
  await mkdir(project);
  execFileSync('git', ['init', '-b', 'main', project]);
  const prepareOutput = execFileSync(process.execPath, [join(destination, '.agents/skills/cc/scripts/init.mjs'), 'prepare', '--cwd', project], { encoding: 'utf8' });
  const prepared = JSON.parse(prepareOutput);
  assert.equal(prepared.ok, true);
  const detailsPath = join(root, 'details.json');
  await writeFile(detailsPath, JSON.stringify({ purpose: 'Packed fixture', checks: [], skills: [], setupGaps: ['Confirm checks'] }));
  const registered = JSON.parse(execFileSync(process.execPath, [join(destination, '.claude/skills/cc/scripts/init.mjs'), 'register', '--report', prepared.reportPath, '--details', detailsPath], { encoding: 'utf8', cwd: destination }));
  assert.equal(registered.id, 'local-fixture');
  assert.match(await readFile(registered.configPath, 'utf8'), /Confirm checks/);
  const grokHome = join(root, 'grok home');
  const grokOutput = npm('exec', '--offline', '--yes', `--package=${tarball}`, '--', 'create-command-center', grokHome, '--agent', 'grok');
  assert.match(grokOutput, /Command Center installed/);
  await verifySkills(grokHome, '.grok');
  assert.ok(!(await readdir(grokHome)).includes('node_modules'));
  const grokPrepared = JSON.parse(execFileSync(process.execPath, [join(grokHome, '.grok/skills/cc/scripts/init.mjs'), 'prepare', '--cwd', project], { encoding: 'utf8' }));
  assert.equal(grokPrepared.ok, true);
  assert.ok(grokPrepared.catalog.skills.some(skill => skill.name === 'cc' && skill.path === 'skills/ready/cc/SKILL.md'));
  const addHome = join(root, 'add home');
  npm('exec', '--offline', '--yes', `--package=${tarball}`, '--', 'create-command-center', addHome, '--agent', 'codex');
  const added = npm('exec', '--offline', '--yes', `--package=${tarball}`, '--', 'create-command-center', addHome, '--add-agent', 'grok');
  assert.match(added, /Command Center updated/);
  await verifySkills(addHome, '.grok');
  const addedPrepared = JSON.parse(execFileSync(process.execPath, [join(addHome, '.grok/skills/cc/scripts/init.mjs'), 'prepare', '--cwd', project], { encoding: 'utf8' }));
  assert.equal(addedPrepared.ok, true);
  assert.deepEqual(JSON.parse(await readFile(join(addHome, '.command-center.json'), 'utf8')).agents, ['codex', 'grok']);
  const cli = join(source, 'bin/create-command-center.mjs');
  const noAgent = spawnSync(process.execPath, [cli, join(root, 'no-agent')], { encoding: 'utf8' });
  assert.equal(noAgent.status, 1);
  assert.match(noAgent.stderr, /Non-interactive installation requires/);
});
