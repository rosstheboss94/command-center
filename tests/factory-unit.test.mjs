import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveConfig, validateReport, nextStage } from '../skills/cc/scripts/factory/model.mjs';
import { providerCommand, providerReport } from '../skills/cc/scripts/factory/providers.mjs';

const sha = 'a'.repeat(40);
test('factory settings resolve role overrides without retaining another provider model', () => {
  const config = effectiveConfig({ default: { runner: 'codex', model: 'example' }, roles: { builder: { runner: 'grok' } } }, 'claude');
  assert.equal(config.concurrency, 3);
  assert.equal(config.maxRounds, 3);
  assert.deepEqual(config.roles.builder, { runner: 'grok', model: null, timeoutSeconds: 1800 });
  assert.equal(config.roles['review-code'].model, 'example');
  assert.throws(() => effectiveConfig({ concurrency: 0 }, 'codex'));
  assert.throws(() => effectiveConfig({ roles: { builder: { runner: 'other' } } }, 'codex'));
});
test('reports require the exact commit, a role verdict, and concrete evidence', () => {
  const report = { verdict: 'PASS', commit: sha, findings: [], evidence: ['Inspected diff'] };
  assert.deepEqual(validateReport(report, 'review-code', sha), report);
  assert.throws(() => validateReport({ ...report, commit: 'b'.repeat(40) }, 'review-code', sha));
  assert.throws(() => validateReport({ ...report, verdict: 'READY' }, 'review-code', sha));
  assert.throws(() => validateReport({ ...report, evidence: [] }, 'review-code', sha));
  assert.throws(() => validateReport({ ...report, findings: ['bug'] }, 'review-code', sha));
});
test('transitions do not bypass verification, review or approval', () => {
  assert.equal(nextStage('intake', 'ACCEPT'), 'spec');
  assert.equal(nextStage('intake', 'NEEDS_INFO'), 'blocked');
  assert.equal(nextStage('review', 'CHANGES'), 'build');
  assert.equal(nextStage('approve', 'APPROVE'), 'deliver');
  assert.throws(() => nextStage('build', 'APPROVE'));
});
test('provider adapters use restricted read roles and never bypass permissions', () => {
  for (const runner of ['codex', 'claude', 'grok']) {
    const command = providerCommand({ runner, model: null }, 'review-code', 'prompt');
    assert.equal(command.file, runner);
    assert.doesNotMatch(command.args.join(' '), /bypass|always-approve|danger-full/);
    assert.match(command.args.join(' '), /read-only|Read|read_file/);
  }
});
test('provider envelopes require completed successful output', () => {
  const report = { verdict: 'PASS', commit: sha, findings: [], evidence: ['diff'] };
  assert.deepEqual(providerReport('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report) })), report);
  assert.deepEqual(providerReport('codex', [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } }), JSON.stringify({ type: 'turn.completed' })].join('\n')), report);
  assert.throws(() => providerReport('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } })));
  assert.throws(() => providerReport('claude', JSON.stringify({ type: 'result', is_error: true, result: JSON.stringify(report) })));
  assert.throws(() => providerReport('grok', '{}'));
});
