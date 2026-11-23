import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectArchive, prepareReleaseInputs, bundledReleaseInputs, releaseInputs } from '../skills/cc/scripts/factory/release-inputs.mjs';

function archive(files, type = '0') {
  const chunks = [];
  for (const [path, value] of files) {
    const bytes = Buffer.from(value), header = Buffer.alloc(512);
    header.write(`package/${path}`); header.write('0000644\0', 100);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function release(version = '0.4.0', additions = [], type = '0') {
  const files = [
    ['package.json', JSON.stringify({ name: 'create-command-center', version })],
    ['installer/template/AGENTS.md', '# Home'], ['installer/template/gitignore', '/projects/\n'],
    ['skills/cc/SKILL.md', 'cc'], ['references/checklist.md', 'check'],
    ['LICENSE', 'license'], ['LICENSE.agent-skills', 'upstream license'], ['UPSTREAM.md', 'origin'], ...additions,
  ];
  const bytes = archive(files, type);
  const metadata = { name: 'create-command-center', version, dist: { fileCount: files.length,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    tarball: `https://registry.npmjs.org/create-command-center/-/create-command-center-${version}.tgz` } };
  return { bytes, metadata };
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-releases-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(home);
  return { root, home };
}
test('verified package yields complete canonical and conditional host inventories without executing code', () => {
  const { bytes, metadata } = release(); const inventory = inspectArchive(bytes, metadata);
  assert.equal(Object.keys(inventory.packageFiles).length, metadata.dist.fileCount);
  assert.equal(inventory.managedFiles['skills/cc/SKILL.md'].sha256, inventory.managedFiles['.grok/skills/cc/SKILL.md'].sha256);
  assert.equal(inventory.managedFiles['.agents/references/checklist.md'].agent, 'codex');
  assert.ok(inventory.markers['claude,codex,grok']);
  const older = release('0.3.0');
  assert.equal(inspectArchive(older.bytes, older.metadata).managedFiles['.grok/skills/cc/SKILL.md'], undefined);
});
test('archive verification rejects corruption, mismatched identity/version, unsafe entries and duplicates', () => {
  const r = release();
  assert.throws(() => inspectArchive(Buffer.from('corrupt'), r.metadata), /integrity/);
  assert.throws(() => inspectArchive(r.bytes, { ...r.metadata, version: '0.3.0', dist: { ...r.metadata.dist, tarball: r.metadata.dist.tarball.replace('0.4.0', '0.3.0') } }), /identity|version/);
  for (const [path, type] of [['../escape', '0'], ['linked', '2'], ['skills/cc/SKILL.md', '0'], ['C:/escape', '0']]) {
    const unsafe = release('0.4.0', [[path, 'x']], type);
    assert.throws(() => inspectArchive(unsafe.bytes, unsafe.metadata), /path|entry|duplicate/i);
  }
});
test('host prefetch verifies metadata and archives; offline cache and explicit local import avoid network', async t => {
  const { root, home } = await temporary(t), r = release(); let requests = 0;
  const fetcher = async url => { requests++; return { ok: true, json: async () => r.metadata, arrayBuffer: async () => r.bytes }; };
  const options = { trusted: [r.metadata], fetcher };
  await prepareReleaseInputs(home, options); assert.equal(requests, 2);
  const cached = await prepareReleaseInputs(home, { ...options, offline: true, fetcher: () => { throw new Error('network forbidden'); } });
  assert.equal(cached[0].version, '0.4.0');
  const local = join(root, 'local'); await mkdir(local);
  await writeFile(join(local, 'create-command-center-0.4.0.tgz'), r.bytes);
  const imported = await prepareReleaseInputs(home, { ...options, from: local, offline: true });
  assert.equal(imported[0].version, '0.4.0');
  await writeFile(join(home, '.cc/factory/release-inputs/0.4.0/package.tgz'), 'corrupt');
  await assert.rejects(prepareReleaseInputs(home, { ...options, offline: true }), /0.4.0.*integrity/s);
});
test('missing metadata, registry denial, wrong metadata and partial caches produce actionable failures', async t => {
  const { home } = await temporary(t), r = release();
  await assert.rejects(prepareReleaseInputs(home, { trusted: [r.metadata], offline: true }), /0.4.0.*release-inputs/s);
  await assert.rejects(prepareReleaseInputs(home, { trusted: [r.metadata], fetcher: async () => { throw new Error('EACCES'); } }), /0.4.0.*EACCES/s);
  await assert.rejects(prepareReleaseInputs(home, { trusted: [r.metadata], fetcher: async () => ({ ok: true, json: async () => ({ ...r.metadata, version: '9.9.9' }) }) }), /metadata/);
});
test('shipped 0.3.0 and 0.4.0 inventories are complete and usable with no registry access', async t => {
  const { home } = await temporary(t);
  const bundled = await bundledReleaseInputs();
  assert.deepEqual(bundled.map(item => item.version), ['0.3.0', '0.4.0']);
  for (const entry of bundled) {
    const inventory = JSON.parse(await readFile(entry.inventoryPath, 'utf8'));
    assert.equal(Object.keys(inventory.packageFiles).length, inventory.package.dist.fileCount);
    assert.ok(Object.keys(inventory.managedFiles).length > 100);
  }
  assert.deepEqual((await releaseInputs(home)).map(item => item.version), ['0.3.0', '0.4.0']);
});

test('prefetch bounds streaming responses and refuses linked cache paths', async t => {
  const { root, home } = await temporary(t), r = release();
  let calls = 0;
  await assert.rejects(prepareReleaseInputs(home, { trusted: [r.metadata], fetcher: async () => ++calls === 1
    ? { ok: true, json: async () => r.metadata }
    : { ok: true, body: (async function* () { yield Buffer.alloc(3 * 1024 * 1024); yield Buffer.alloc(2 * 1024 * 1024); })() } }), /size limit/);
  const cache = join(home, '.cc/factory/release-inputs'); await mkdir(cache, { recursive: true });
  const target = join(root, 'linked-cache'); await mkdir(target);
  await symlink(target, join(cache, '0.4.0'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareReleaseInputs(home, { trusted: [r.metadata], offline: true }), /Linked/);
});
