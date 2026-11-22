import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fixture } from './factory-fixture.mjs';
import { execute } from '../skills/cc/scripts/factory/io.mjs';
const helper = fileURLToPath(new URL('../skills/cc/scripts/factory.mjs', import.meta.url));
test('bare factory invocation and status are read-only and expose factory operations', async () => {
  const result = await execute(process.execPath, [helper]);
  assert.equal(result.code, 0);
  assert.ok(JSON.parse(result.stdout).operations.includes('adopt'));
});
test('factory CLI discovers home, shows effective configuration, and lists no jobs', async t => {
  const f = await fixture(t);
  const config = await execute(process.execPath, [helper, 'config', '--home', f.home, '--repo', f.repo, '--host', 'codex']);
  assert.equal(config.code, 0, config.stderr);
  assert.equal(JSON.parse(config.stdout).result.config.concurrency, 3);
  const status = await execute(process.execPath, [helper, 'status', '--home', f.home]);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).result, []);
});
test('factory CLI rejects ambiguous input and never accepts arbitrary gate advancement', async () => {
  const result = await execute(process.execPath, [helper, 'advance', '--stage', 'ready']);
  assert.notEqual(result.code, 0);
});
