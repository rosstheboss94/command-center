import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './factory-fixture.mjs';
import { loadContext } from '../skills/ready/cc/scripts/factory/project.mjs';
import { effectiveConfig } from '../skills/ready/cc/scripts/factory/model.mjs';
import { createJob, saveJob } from '../skills/ready/cc/scripts/factory/store.mjs';
import { runJob, resumeJob } from '../skills/ready/cc/scripts/factory/engine.mjs';
import { execute } from '../skills/ready/cc/scripts/factory/io.mjs';

const report = (role, commit) => ({ verdict: role === 'intake' ? 'ACCEPT' : role === 'approver' ? 'APPROVE' : 'READY', commit, findings: [], evidence: ['Fixture inspection'], ...(['spec', 'plan'].includes(role) ? { artifact: `Fixture ${role}` } : {}) });
test('blocking defaults off and accepts an explicit strict opt-in', () => {
  assert.equal(effectiveConfig({}, 'codex').blocking, false);
  assert.equal(effectiveConfig({ blocking: true }, 'codex').blocking, true);
  assert.throws(() => effectiveConfig({ blocking: 'false' }, 'codex'));
});
test('advisory jobs deliver with honest failed checks and nonpassing role reports', async t => {
  const f = await fixture(t, { blocking: false }), context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Implement despite workflow warnings');
  const result = await runJob(f.home, f.repo, job.id, {
    run: (file, args, options) => file === 'npm' ? Promise.resolve({ code: 1, stdout: '', stderr: 'Fixture check failed' }) : execute(file, args, options),
    runRole: async ({ role, commit, worktree }) => {
      if (role === 'spec') throw new Error('Fixture provider unavailable');
      if (role === 'builder') await writeFile(join(worktree, 'app.txt'), 'after\n');
      if (['intake', 'builder', 'approver'].includes(role)) return { ...report(role, commit), verdict: role === 'intake' ? 'NEEDS_INFO' : 'BLOCKED', findings: [`Fixture ${role} warning`] };
      return report(role, commit);
    },
    deliver: async state => { assert.equal(state.checks.passed, false); assert.equal(state.reports.approver.verdict, 'BLOCKED'); return { url: 'https://example.invalid/advisory', head: state.commit }; },
  });
  assert.equal(result.stage, 'ready', result.blocker); assert.equal(result.requiresFeedback, false);
  assert.ok(result.workflowWarnings.some(warning => warning.message.includes('provider unavailable')));
  assert.ok(result.workflowWarnings.some(warning => warning.stage === 'verify'));
  assert.equal(result.reports.builder.verdict, 'BLOCKED'); assert.equal(result.round, 1);
});
test('real delivery errors fail visibly and explicit resume retries without an approval gate', async t => {
  const f = await fixture(t, { blocking: false }), job = await createJob(await loadContext(f.home, f.repo, 'codex'), 'Retry delivery');
  const runRole = async ({ role, commit, worktree }) => { if (role === 'builder') await writeFile(join(worktree, 'app.txt'), 'after\n'); return report(role, commit); };
  const failed = await runJob(f.home, f.repo, job.id, { runRole, deliver: async () => { throw new Error('Fixture authentication failure'); } });
  assert.equal(failed.stage, 'failed'); assert.equal(failed.requiresFeedback, false); assert.equal(failed.interruptedStage, 'deliver');
  const ready = await resumeJob(f.home, f.repo, job.id, { runRole, deliver: async state => ({ url: 'https://example.invalid/retry', head: state.commit }) });
  assert.equal(ready.stage, 'ready', ready.blocker); assert.equal(ready.round, 1);
});

test('old feedback and round-limit stops resume without resetting the saved budget', async t => {
  const f = await fixture(t, { blocking: false }), context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Resume an exhausted historical job'); let builders = 0;
  const runRole = async ({ role, commit, worktree }) => { if (role === 'builder') { builders++; await writeFile(join(worktree, 'app.txt'), 'preserved implementation\n'); } return report(role, commit); };
  const stopped = await runJob(f.home, f.repo, job.id, { runRole, deliver: async () => { throw new Error('Fixture old delivery failure'); } });
  stopped.stage = 'blocked'; stopped.interruptedStage = 'build'; stopped.requiresFeedback = true; stopped.round = context.config.maxRounds;
  await saveJob(stopped, 'Fixture historical blocked build with exhausted rounds.'); builders = 0;
  const result = await resumeJob(f.home, f.repo, job.id, { runRole, deliver: async state => ({ url: 'https://example.invalid/exhausted', head: state.commit }) });
  assert.equal(result.stage, 'ready', result.blocker); assert.equal(result.round, context.config.maxRounds); assert.equal(builders, 0); assert.equal(result.requiresFeedback, false);
  assert.ok(result.workflowWarnings.some(warning => warning.message.includes('round limit')));
});
