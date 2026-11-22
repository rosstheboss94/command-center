import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { installHome } from '../installer/install.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function verifySkills(home, folder) {
  const skills = join(home, folder, 'skills');
  assert.equal((await readdir(skills)).length, 27);
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

for (const agent of ['codex', 'claude', 'both']) {
  test(`installs ${agent} skills with resolving references`, async t => {
    const root = await fixture(t);
    const home = join(root, 'home with spaces');
    await installHome(home, agent);
    await verifySkills(home, '.');
    if (agent !== 'claude') await verifySkills(home, '.agents');
    if (agent !== 'codex') {
      await verifySkills(home, '.claude');
      assert.match(await readFile(join(home, 'CLAUDE.md'), 'utf8'), /AGENTS.md/);
    }
    await access(join(home, '.git'));
    await access(join(home, 'LICENSE.agent-skills'));
    await access(join(home, 'LICENSE'));
    const ignored = execFileSync('git', ['-C', home, 'check-ignore', 'projects/owner/repo/file'], { encoding: 'utf8' });
    assert.match(ignored, /projects\/owner\/repo\/file/);
    assert.equal(JSON.parse(await readFile(join(home, '.command-center.json'))).templateVersion, '0.2.0');
    const names = await readdir(home);
    assert.ok(!names.includes('installer') && !names.includes('bin') && !names.includes('package.json'));
  });
}

test('repeat and interrupted installs preserve configuration and user records', async t => {
  const root = await fixture(t);
  const home = join(root, 'home');
  await installHome(home, 'codex');
  await mkdir(join(home, 'repos/custom'));
  await writeFile(join(home, 'repos/custom/config.md'), 'chosen settings');
  const missing = join(home, 'skills/cc/assets/config.md');
  await rm(missing);
  await installHome(home, 'codex');
  await access(missing);
  assert.equal(await readFile(join(home, 'repos/custom/config.md'), 'utf8'), 'chosen settings');
  assert.deepEqual((await installHome(home, 'codex')).written, []);
  await installHome(home, 'claude');
  assert.deepEqual(JSON.parse(await readFile(join(home, '.command-center.json'))).agents, ['claude', 'codex']);
});

test('conflicting files cause no writes', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'AGENTS.md'), 'my instructions');
  const before = await readdir(root);
  await assert.rejects(installHome(root, 'both'), /Existing files differ/);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'my instructions');
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
  const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: source, encoding: 'utf8', timeout: 120000,
  });
  const packed = JSON.parse(npm('pack', '--json', '--pack-destination', root));
  const tarball = join(root, packed[0].filename);
  const shipped = packed[0].files.map(file => file.path);
  assert.ok(shipped.includes('installer/template/gitignore'));
  assert.ok(shipped.every(path => !path.startsWith('tests/') && !path.startsWith('jobs/') && !path.startsWith('projects/')));
  const destination = join(root, 'installed home');
  const output = npm('exec', '--offline', '--yes', `--package=${tarball}`, '--', 'create-command-center', destination, '--agent', 'both');
  assert.match(output, /Command Center installed/);
  await verifySkills(destination, '.agents');
  await verifySkills(destination, '.claude');
  await access(join(destination, '.gitignore'));
  const cli = join(source, 'bin/create-command-center.mjs');
  const noAgent = spawnSync(process.execPath, [cli, join(root, 'no-agent')], { encoding: 'utf8' });
  assert.equal(noAgent.status, 1);
  assert.match(noAgent.stderr, /Non-interactive installation requires/);
});
