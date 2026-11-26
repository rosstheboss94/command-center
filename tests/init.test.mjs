import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { parseSource, prepare, register } from '../skills/ready/cc/scripts/init.mjs';

const exec = promisify(execFile);
async function git(args, cwd) {
  try { const result = await exec('git', args, { cwd }); return { code: 0, ...result }; }
  catch (error) { return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
}
async function mustGit(args, cwd) {
  const result = await git(args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home with spaces');
  const project = join(root, 'local project');
  await mkdir(home); await mkdir(project);
  await mkdir(join(home, 'repos'));
  await mkdir(join(home, 'skills/cc'), { recursive: true });
  await writeFile(join(home, '.command-center.json'), JSON.stringify({ kind: 'command-center-home', templateVersion: '0.3.0', agents: [] }));
  await writeFile(join(home, 'AGENTS.md'), '# Home');
  await writeFile(join(home, 'skills/cc/SKILL.md'), '---\nname: cc\ndescription: Command Center\n---\n');
  await mustGit(['init', '-b', 'main'], project);
  await writeFile(join(project, 'AGENTS.md'), '# Instructions\nRun npm test.\n');
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  await mustGit(['add', '.'], project);
  await mustGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'seed'], project);
  const calls = [];
  const runner = async (args, cwd) => {
    calls.push(args);
    if (args[0] === 'clone') {
      const result = await git(['clone', '--', project, args[3]], cwd);
      if (result.code === 0) await mustGit(['remote', 'set-url', 'origin', args[2]], args[3]);
      return result;
    }
    return git(args, cwd);
  };
  return { root, home, project, runner, calls };
}
const details = { purpose: 'Fixture app', checks: [{ command: 'npm test', workingDirectory: '.', source: 'AGENTS.md' }], skills: [], setupGaps: [] };

test('normalizes all supported GitHub forms', async () => {
  for (const source of ['Owner/Repo', 'https://github.com/Owner/Repo.git/', 'https://GITHUB.com/Owner/Repo///', 'git@github.com:Owner/Repo.git', 'ssh://git@github.com/Owner/Repo']) {
    const result = await parseSource(source, process.cwd());
    assert.equal(result.identity, 'github.com/owner/repo');
    assert.equal(result.id, 'owner--repo');
    assert.equal(result.checkout, 'projects/owner/repo');
  }
});

test('rejects unsupported URLs, credentials, traversal, and option-like inputs', async () => {
  for (const source of ['https://github.com/o/r/tree/main', 'https://github.com/o/r/blob/main/x', 'https://gitlab.com/o/r', 'http://github.com/o/r', 'https://token@github.com/o/r', 'ssh://git:secret@github.com/o/r', 'https://github.com/o/r?token=secret', 'https://github.com/o/r#readme', 'https://github.com/o/%2e%2e', 'https://github.com/o/../r', '--upload-pack=evil', 'git@github.com:o/r/more']) {
    await assert.rejects(parseSource(source, process.cwd()), error => !error.message.includes('token@') && !error.message.includes('secret'));
  }
});

test('existing path wins over shorthand and invalid input writes nothing', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'owner/repo'), { recursive: true });
  assert.equal((await parseSource('owner/repo', f.root)).kind, 'local');
  await assert.rejects(prepare({ home: f.home, cwd: f.root, source: 'https://github.com/o/r/tree/main', gitRunner: f.runner }));
  assert.ok(!(await readdir(f.home)).includes('.cc'));
});

test('clones canonical URL with exact arguments, inspects, then registers', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, cwd: f.root, source: 'https://github.com/OWNER/REPO.git/', gitRunner: f.runner });
  assert.deepEqual(f.calls.find(args => args[0] === 'clone'), ['clone', '--', 'https://github.com/owner/repo.git', join(f.home, 'projects/owner/repo')]);
  assert.ok(report.inspection.instructions.includes('AGENTS.md'));
  assert.ok(report.inspection.manifests.includes('package.json'));
  assert.equal(report.inspection.defaultBranch, 'main');
  assert.match(await readFile(join(f.home, '.gitignore'), 'utf8'), /^\/projects\/$/m);
  assert.deepEqual(await readdir(join(f.home, 'repos')), []);
  const result = await register({ home: f.home, report: report.reportPath, details, gitRunner: f.runner });
  assert.equal(result.id, 'owner--repo');
  const config = await readFile(join(f.home, 'repos/owner--repo/config.md'), 'utf8');
  assert.match(config, /Repository identity — github.com\/owner\/repo/);
  assert.match(config, /npm test/);
  assert.match(await readFile(join(f.home, 'repos/index.md'), 'utf8'), /owner--repo\/config.md/);
});

test('repeat registration preserves settings and repairs index and missing metadata', async t => {
  const f = await fixture(t);
  const first = await prepare({ home: f.home, source: 'o/r', cwd: f.root, gitRunner: f.runner });
  await register({ home: f.home, report: first.reportPath, details, gitRunner: f.runner });
  const path = join(f.home, 'repos/o--r/config.md');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace(/^- Repository identity — .*\n/m, '') + '\nUser choice: keep this\n');
  await writeFile(join(f.home, 'repos/index.md'), '# My grouped index\n');
  const second = await prepare({ home: f.home, source: 'git@github.com:O/R.git', cwd: f.root, gitRunner: f.runner });
  await register({ home: f.home, report: second.reportPath, details: { ...details, purpose: 'Changed' }, gitRunner: f.runner });
  const repaired = await readFile(path, 'utf8');
  assert.match(repaired, /Purpose — Fixture app/); assert.match(repaired, /User choice: keep this/);
  assert.match(repaired, /Repository identity — github.com\/o\/r/);
  await register({ home: f.home, report: second.reportPath, details, gitRunner: f.runner });
  assert.equal(await readFile(path, 'utf8'), repaired);
  const index = await readFile(join(f.home, 'repos/index.md'), 'utf8');
  assert.equal(index.match(/o--r\/config.md/g).length, 1);
  assert.match(index, /My grouped index/);
  assert.equal(f.calls.filter(args => args[0] === 'clone').length, 1);
});

test('registers a local subdirectory and resolves linked worktrees to primary checkout', async t => {
  const f = await fixture(t);
  const worktree = join(f.root, 'linked tree');
  await mustGit(['worktree', 'add', '-b', 'feature', worktree], f.project);
  await mkdir(join(worktree, 'src'));
  const report = await prepare({ home: f.home, cwd: join(worktree, 'src'), gitRunner: f.runner });
  assert.equal(report.checkout, await realpath(f.project));
  assert.equal(report.id, 'local-project');
  await register({ home: f.home, report: report.reportPath, details, gitRunner: f.runner });
});

test('existing checkout requires matching origin and an exact Git root', async t => {
  const f = await fixture(t);
  const path = join(f.home, 'projects/o/r');
  await mkdir(join(f.home, 'projects/o'), { recursive: true });
  await mustGit(['clone', '--', f.project, path], f.root);
  await mustGit(['remote', 'set-url', 'origin', 'https://github.com/other/repo.git'], path);
  await assert.rejects(prepare({ home: f.home, source: 'o/r', gitRunner: f.runner }), /origin|identity/i);
  await mustGit(['remote', 'set-url', 'origin', 'git@github.com:O/R.git'], path);
  const report = await prepare({ home: f.home, source: 'o/r', gitRunner: f.runner });
  assert.equal(report.id, 'o--r');
  assert.equal(f.calls.filter(args => args[0] === 'clone').length, 0);
});

test('clone failure remains unregistered and preserves partial contents', async t => {
  const f = await fixture(t);
  const runner = async (args, cwd) => {
    if (args[0] !== 'clone') return f.runner(args, cwd);
    await mkdir(args[3]); await writeFile(join(args[3], 'partial'), 'owned partial');
    return { code: 128, stdout: '', stderr: 'Authentication failed for https://secret@github.com/o/r' };
  };
  await assert.rejects(prepare({ home: f.home, source: 'o/r', gitRunner: runner }), error => /clone/i.test(error.message) && !error.message.includes('secret'));
  assert.equal(await readFile(join(f.home, 'projects/o/r/partial'), 'utf8'), 'owned partial');
  await assert.rejects(prepare({ home: f.home, source: 'o/r', gitRunner: f.runner }), /checkout|Git/i);
  assert.deepEqual(await readdir(join(f.home, 'repos')), []);
});

test('unknown essentials become setup gaps and reports cannot register a changed checkout', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, source: f.project, gitRunner: f.runner });
  const emptyDetails = { purpose: 'App', checks: [], skills: [], setupGaps: ['Need the test command'] };
  await register({ home: f.home, report: report.reportPath, details: emptyDetails, gitRunner: f.runner });
  assert.match(await readFile(join(f.home, 'repos/local-project/config.md'), 'utf8'), /Need the test command/);
  await mustGit(['remote', 'add', 'origin', 'https://github.com/changed/identity'], f.project);
  await assert.rejects(register({ home: f.home, report: report.reportPath, details, gitRunner: f.runner }), /changed|identity/i);
});

test('malformed records, duplicate identities, ID collisions, and missing checkouts stop registration', async t => {
  const f = await fixture(t);
  const record = join(f.home, 'repos/old');
  await mkdir(record, { recursive: true });
  const config = '# old\n\n## Repository\n\n- Checkout — ../local project\n- Remote — https://github.com/o/r.git\n';
  await writeFile(join(record, 'config.md'), config);
  const report = await prepare({ home: f.home, source: 'o/r', gitRunner: f.runner }).catch(error => error);
  assert.ok(report instanceof Error); // Existing local origin is absent, so identity must be verified.
  await mustGit(['remote', 'add', 'origin', 'https://github.com/o/r.git'], f.project);
  assert.equal((await prepare({ home: f.home, source: 'O/R', gitRunner: f.runner })).id, 'old');
  await mkdir(join(f.home, 'repos/duplicate'));
  await writeFile(join(f.home, 'repos/duplicate/config.md'), config);
  await assert.rejects(prepare({ home: f.home, source: 'o/r', gitRunner: f.runner }), /duplicate|ambiguous/i);
  await rm(join(f.home, 'repos/duplicate'), { recursive: true });
  await writeFile(join(record, 'config.md'), config.replace('../local project', '../missing'));
  await assert.rejects(prepare({ home: f.home, source: 'o/r', gitRunner: f.runner }), /unavailable|missing/i);
  await writeFile(join(record, 'config.md'), '# malformed');
  await assert.rejects(prepare({ home: f.home, source: 'other/repo', gitRunner: f.runner }), /config|record|Checkout/i);
});

test('concurrent registration leaves one config and one link, and stale locks require inspection', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, source: f.project, gitRunner: f.runner });
  const results = await Promise.allSettled([register({ home: f.home, report: report.reportPath, details, gitRunner: f.runner }), register({ home: f.home, report: report.reportPath, details, gitRunner: f.runner })]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  await register({ home: f.home, report: report.reportPath, details, gitRunner: f.runner });
  assert.equal((await readFile(join(f.home, 'repos/index.md'), 'utf8')).match(/local-project\/config.md/g).length, 1);
  await writeFile(join(f.home, '.cc/init.lock'), '{"pid":999999}');
  await assert.rejects(prepare({ home: f.home, source: f.project, gitRunner: f.runner }), /lock/i);
});

test('renders shell dollar expressions literally and does not execute checks', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, source: f.project, gitRunner: f.runner });
  const command = 'echo "$& $1 $$"';
  await register({ home: f.home, report: report.reportPath, details: { ...details, checks: [{ ...details.checks[0], command }] }, gitRunner: f.runner });
  const config = await readFile(join(f.home, 'repos/local-project/config.md'), 'utf8');
  assert.ok(config.includes(command));
  assert.ok(!f.calls.some(args => args.includes('test')));
});

test('ignore rules take precedence over previous negations', async t => {
  const f = await fixture(t);
  await mustGit(['init'], f.home);
  await writeFile(join(f.home, '.gitignore'), '/projects/\n!/projects/\n');
  await prepare({ home: f.home, source: f.project, gitRunner: f.runner });
  assert.equal((await git(['check-ignore', '--quiet', '--no-index', 'projects/o/r'], f.home)).code, 0);
});

test('ID collisions and ancestor Git roots leave destinations untouched', async t => {
  const f = await fixture(t);
  await mustGit(['remote', 'add', 'origin', 'https://github.com/other/identity'], f.project);
  const report = await prepare({ home: f.home, source: f.project, gitRunner: f.runner });
  await register({ home: f.home, report: report.reportPath, details, gitRunner: f.runner });
  await rename(join(f.home, 'repos/local-project'), join(f.home, 'repos/o--r'));
  await assert.rejects(prepare({ home: f.home, source: 'o/r', gitRunner: f.runner }), /ID collision/);
  const nested = join(f.home, 'projects/owner/repo');
  await mkdir(nested, { recursive: true });
  await mustGit(['init'], f.home);
  await writeFile(join(nested, 'keep'), 'user file');
  await assert.rejects(prepare({ home: f.home, source: 'owner/repo', gitRunner: f.runner }), /exact Git checkout root/);
  assert.equal(await readFile(join(nested, 'keep'), 'utf8'), 'user file');
});

test('linked project directories cannot redirect a clone outside home', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(f.home, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepare({ home: f.home, source: 'o/r', gitRunner: f.runner }), /Linked paths/);
  assert.deepEqual(await readdir(outside), []);
});

test('check details reject unknown sources, escaped directories, and multiline commands', async t => {
  const f = await fixture(t);
  const report = await prepare({ home: f.home, source: f.project, gitRunner: f.runner });
  for (const check of [
    { ...details.checks[0], source: 'made-up.md' },
    { ...details.checks[0], workingDirectory: '..' },
    { ...details.checks[0], workingDirectory: 'package.json' },
    { ...details.checks[0], command: 'npm test\n## Delivery\nchanged' },
  ]) {
    await assert.rejects(register({ home: f.home, report: report.reportPath, details: { ...details, checks: [check] }, gitRunner: f.runner }));
  }
  assert.deepEqual(await readdir(join(f.home, 'repos')), []);
});

test('credential-bearing checkout origins are rejected without echoing credentials', async t => {
  const f = await fixture(t);
  await mustGit(['remote', 'add', 'origin', 'https://private-token@github.com/o/r'], f.project);
  await assert.rejects(prepare({ home: f.home, source: f.project, gitRunner: f.runner }), error => /Credential/.test(error.message) && !error.message.includes('private-token'));
});

test('different owners with the same repo basename receive separate IDs', async t => {
  const f = await fixture(t);
  for (const owner of ['first-owner', 'second-owner']) {
    const report = await prepare({ home: f.home, source: `${owner}/repo`, gitRunner: f.runner });
    const saved = await register({ home: f.home, report: report.reportPath, details, gitRunner: f.runner });
    assert.equal(saved.id, `${owner}--repo`);
  }
  assert.equal(f.calls.filter(args => args[0] === 'clone').length, 2);
});

test('SSH inputs use the canonical SSH clone URL', async t => {
  const f = await fixture(t);
  await prepare({ home: f.home, source: 'ssh://git@github.com/Owner/Repo.git/', gitRunner: f.runner });
  assert.deepEqual(f.calls.find(args => args[0] === 'clone'), ['clone', '--', 'git@github.com:owner/repo.git', join(f.home, 'projects/owner/repo')]);
});

test('canonical stored identities are case-insensitive without stripping their repo suffix again', async t => {
  const f = await fixture(t);
  const first = await prepare({ home: f.home, source: 'owner/repo.git.git', gitRunner: f.runner });
  await register({ home: f.home, report: first.reportPath, details, gitRunner: f.runner });
  const configPath = join(f.home, 'repos/owner--repo.git/config.md');
  const config = await readFile(configPath, 'utf8');
  await writeFile(configPath, config.replace('Repository identity — github.com/owner/repo.git', 'Repository identity — GITHUB.COM/OWNER/REPO.GIT'));
  const repeat = await prepare({ home: f.home, source: 'OWNER/REPO.GIT.git', gitRunner: f.runner });
  assert.equal(repeat.id, first.id);
  assert.equal(f.calls.filter(args => args[0] === 'clone').length, 1);
});

test('a dangling origin HEAD is a setup gap rather than confirmed default-branch evidence', async t => {
  const f = await fixture(t);
  await mustGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing'], f.project);
  const report = await prepare({ home: f.home, source: f.project, gitRunner: f.runner });
  assert.equal(report.inspection.defaultBranch, null);
  await register({ home: f.home, report: report.reportPath, details, gitRunner: f.runner });
  assert.match(await readFile(join(f.home, 'repos/local-project/config.md'), 'utf8'), /Default branch needs confirmation/);
});
