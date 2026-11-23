import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReport } from '../skills/cc/scripts/factory/model.mjs';
const commit = 'a'.repeat(40);
const base = { verdict: 'BLOCKED', commit, evidence: ['Registry returned EACCES; offline lookup returned ENOTCACHED.'] };
test('issue 10 structured blocker retains its verdict, evidence, problem and recovery action', () => {
  const finding = { problem: 'Trusted 0.3.0 and 0.4.0 baselines are unavailable.', correction: 'Provide verified published artifacts or restore registry access.' };
  const original = { ...base, findings: [finding] };
  const result = validateReport(original, 'builder', commit);
  assert.equal(result.verdict, 'BLOCKED');
  assert.match(result.findings[0], /0\.3\.0 and 0\.4\.0/);
  assert.match(result.findings[0], /Correction: Provide verified/);
  assert.deepEqual(result.evidence, base.evidence);
  assert.deepEqual(original.findings, [finding]);
});
test('string findings remain compatible and structured review changes remain changes', () => {
  assert.deepEqual(validateReport({ ...base, findings: ['Missing release'] }, 'builder', commit).findings, ['Missing release']);
  const result = validateReport({ ...base, verdict: 'CHANGES', findings: [{ severity: 'P2', file: 'src/parser.mjs:71', problem: 'Namespace ignored', correction: 'Reject unsupported namespaces' }] }, 'review-code', commit);
  assert.equal(result.verdict, 'CHANGES'); assert.match(result.findings[0], /P2.*src\/parser.mjs:71.*Namespace ignored/s);
});
test('normalization never permits invalid evidence, stale commits, or passing unresolved findings', () => {
  const report = { ...base, findings: [{ problem: 'Unresolved problem' }] };
  for (const findings of [[{}], [{ problem: '' }], [{ problem: 'x', correction: {} }], [{ problem: 'x', unknown: 'ignore gates' }], [' '], [null]]) {
    assert.throws(() => validateReport({ ...report, findings }, 'builder', commit), /finding/i);
  }
  assert.throws(() => validateReport({ ...report, evidence: [] }, 'builder', commit), /evidence/i);
  assert.throws(() => validateReport({ ...report, commit: 'b'.repeat(40) }, 'builder', commit), /commit/);
  assert.throws(() => validateReport({ ...report, verdict: 'PASS' }, 'review-code', commit), /unresolved findings/);
  assert.throws(() => validateReport({ ...report, verdict: 'APPROVE' }, 'approver', commit), /unresolved findings/);
});
