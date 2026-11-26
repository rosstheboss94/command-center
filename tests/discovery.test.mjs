import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('plugin points at a reproducible flat discovery projection', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url)));
  assert.equal(manifest.skills, './discovery/skills/');
  const output = spawnSync(process.execPath, [fileURLToPath(new URL('../installer/build-discovery.mjs', import.meta.url)), '--check'], { encoding: 'utf8' });
  assert.ifError(output.error);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout, '', 'Lifecycle diagnostics must preserve npm pack --json stdout');
  assert.match(output.stderr, /Verified \d+ discovery files/);
});
