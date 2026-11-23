import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, snapshot, compareSnapshots } from '../skills/ready/cc/scripts/inspection.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'cc-catalog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'skills'));
  const skill = async (path, name) => {
    await mkdir(join(home, 'skills', path), { recursive: true });
    await writeFile(join(home, 'skills', path, 'SKILL.md'), `---\nname: ${name}\ndescription: Example\n---\n`);
  };
  return { home, skill };
}
test('nested and legacy catalogs expose ownership and stop under skill roots', async t => {
  const { home, skill } = await fixture(t);
  await skill('ready/cc', 'cc'); await skill('custom', 'custom');
  await skill('build/widget', 'widget'); await skill('build/widget/assets/example', 'example');
  const catalog = await buildCatalog(home);
  assert.deepEqual(catalog.skills.map(item => [item.name, item.workflowStep, item.layout]), [
    ['widget', 'build', 'nested'], ['custom', null, 'legacy-flat'], ['cc', 'ready', 'nested'],
  ]);
  assert.deepEqual(catalog.diagnostics, []);
});
test('duplicates across owners and flat/nested roots are all unusable', async t => {
  const { home, skill } = await fixture(t);
  await skill('ready/cc', 'cc'); await skill('cc', 'cc'); await skill('build/cc', 'cc');
  const catalog = await buildCatalog(home);
  assert.ok(catalog.diagnostics.some(item => item.code === 'SKILL_AMBIGUOUS'));
  assert.equal(catalog.skills.some(item => item.valid), false);
});
test('unknown ownership, unexpected depths and links have diagnostics without traversal', async t => {
  const { home, skill } = await fixture(t);
  await skill('unknown/widget', 'widget'); await skill('build/deeper/widget', 'widget');
  await symlink(join(home, 'skills'), join(home, 'skills/review'), process.platform === 'win32' ? 'junction' : 'dir');
  const catalog = await buildCatalog(home);
  assert.ok(catalog.diagnostics.some(item => /link/i.test(item.message)));
  assert.equal(catalog.skills.some(item => item.valid), false);
});
test('catalog snapshots detect policy byte changes within the same helper process', async t => {
  const { home, skill } = await fixture(t);
  await skill('ready/cc', 'cc');
  await mkdir(join(home, 'skills/ready/cc/scripts'));
  const path = 'skills/ready/cc/scripts/skill-policy.mjs';
  await writeFile(join(home, path), '// first policy');
  const inspection = { instructions: [], manifests: [], lockfiles: [], ci: [], documentation: [] };
  const before = await snapshot(home, inspection, home, await buildCatalog(home));
  await writeFile(join(home, path), '// changed policy');
  const after = await snapshot(home, inspection, home, await buildCatalog(home));
  assert.ok(compareSnapshots(before, after).includes(`catalog:${path}`));
});
