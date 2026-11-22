import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installHome } from '../installer/install.mjs';
import { prepare, register } from '../skills/cc/scripts/init.mjs';
import { git } from '../skills/cc/scripts/factory/io.mjs';

export async function fixture(t, { github = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cc-factory-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await installHome(home, 'all'); await mkdir(project);
  await git(['init', '-b', 'main'], project);
  await git(['config', 'user.name', 'Factory Fixture'], project);
  await git(['config', 'user.email', 'fixture@example.invalid'], project);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'npm@11.6.2', scripts: { test: 'node -e "process.exit(0)"' } }));
  await writeFile(join(project, 'AGENTS.md'), '# Project\nUse npm test.\n');
  await writeFile(join(project, 'app.txt'), 'before\n');
  await git(['add', '.'], project); await git(['commit', '-m', 'seed'], project);
  if (github) {
    await git(['remote', 'add', 'origin', typeof github === 'string' ? github : 'https://github.com/fixture/cc-factory.git'], project);
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], project);
    await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], project);
  }
  const prepared = await prepare({ home, cwd: project, source: project });
  const registration = await register({ home, cwd: project, report: prepared.reportPath,
    details: { purpose: 'Fixture', skills: [], setupGaps: [], checks: [{ command: 'npm test', workingDirectory: '.', source: 'package.json' }] } });
  const path = join(home, 'repos', registration.id, 'config.md');
  await writeFile(path, (await readFile(path, 'utf8')).replace('Base branch — unknown', 'Base branch — main'));
  return { root, home, project, repo: registration.id };
}
