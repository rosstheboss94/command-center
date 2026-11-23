import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('plugin points at a reproducible flat discovery projection', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url)));
  assert.equal(manifest.skills, './discovery/skills/');
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../installer/build-discovery.mjs', import.meta.url)), '--check'], { encoding: 'utf8' });
  assert.match(output, /Verified \d+ discovery files/);
});
