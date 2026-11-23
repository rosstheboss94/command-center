import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './factory-fixture.mjs';
import { loadContext } from '../skills/ready/cc/scripts/factory/project.mjs';
import { createJob } from '../skills/ready/cc/scripts/factory/store.mjs';
import { runJob, resumeJob } from '../skills/ready/cc/scripts/factory/engine.mjs';
import { execute, hash, git } from '../skills/ready/cc/scripts/factory/io.mjs';

test('existing frozen jobs receive offline release evidence without changing their request/settings', async t => {
  const f = await fixture(t), context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Migrate supported flat homes');
  const before = hash(await readFile(join(job.directory, 'context.json')));
  const seen = [];
  const result = await runJob(f.home, f.repo, job.id, { runRole: async ({ role, commit, context: current }) => {
    assert.deepEqual(current.releaseInputs.map(item => item.version), ['0.3.0', '0.4.0']);
    if (role === 'intake') {
      assert.deepEqual(current.skills.map(item => item.name), ['context-engineering', 'idea-refine', 'interview-me', 'source-driven-development', 'using-agent-skills']);
      assert.ok(current.skills.every(item => item.workflowStep && item.selectionReason));
    }
    for (const entry of current.releaseInputs) assert.ok(JSON.parse(await readFile(entry.inventoryPath, 'utf8')).managedFiles);
    seen.push(role);
    return { verdict: role === 'intake' ? 'ACCEPT' : role === 'builder' ? 'BLOCKED' : 'READY', commit,
      findings: role === 'builder' ? [{ problem: 'Independent fixture blocker', correction: 'Resolve before continuing' }] : [],
      artifact: '# Specification/plan', evidence: ['Inspected supplied published inventories without network access.'] };
  } });
  assert.equal(result.stage, 'blocked'); assert.equal(result.interruptedStage, 'build');
  assert.match(result.blocker, /Independent fixture blocker.*Correction: Resolve/s);
  assert.ok(seen.includes('builder'));
  assert.equal(hash(await readFile(join(job.directory, 'context.json'))), before);
  assert.equal(await readFile(join(job.directory, 'request.md'), 'utf8'), 'Migrate supported flat homes');
});

test('provider raw structured findings are preserved while the actual blocker is accepted', async t => {
  const f = await fixture(t), context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Fixture missing input');
  const finding = { problem: 'Release input missing', correction: 'Supply verified input' };
  const result = await runJob(f.home, f.repo, job.id, { run: async (file, args, options) => {
    if (file !== 'codex') return execute(file, args, options);
    assert.match(options.input, /Verified release inputs/);
    assert.match(options.input, /0\.3\.0\.json/);
    const advertised = JSON.parse(/^Relevant shared skill catalog: (.+)$/m.exec(options.input)[1]);
    assert.deepEqual(advertised.map(item => item.name), ['context-engineering', 'idea-refine', 'interview-me', 'source-driven-development', 'using-agent-skills']);
    const commit = /^COMMIT: (.+)$/m.exec(options.input)[1];
    const text = JSON.stringify({ verdict: 'NEEDS_INFO', commit, findings: [finding], evidence: ['Observed fixture input'] });
    return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) };
  } });
  assert.equal(result.requiresFeedback, true); assert.match(result.blocker, /Release input missing/);
  assert.equal(typeof result.reports.intake.findings[0], 'string');
  const raw = await readFile(join(job.directory, 'attempts', result.attempts[0].id, 'stdout.log'), 'utf8');
  assert.deepEqual(JSON.parse(JSON.parse(raw.split('\n')[0]).item.text).findings, [finding]);
});

test('updating the base of an unfinished build resumes the builder instead of skipping its work', async t => {
  const f = await fixture(t), context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Implement app feature after restoring release inputs');
  const report = ({ role, commit }) => ({ verdict: role === 'intake' ? 'ACCEPT' : role === 'approver' ? 'APPROVE' : 'READY', commit, findings: [], evidence: ['Fixture evidence'], artifact: '# Artifact' });
  const blocked = await runJob(f.home, f.repo, job.id, { runRole: async args => {
    if (args.role === 'builder') throw new Error('Old report parser rejected the blocker');
    return report(args);
  } });
  assert.equal(blocked.interruptedStage, 'build');
  await writeFile(join(f.project, 'infrastructure.txt'), 'release input fix\n');
  await git(['add', 'infrastructure.txt'], f.project); await git(['commit', '-m', 'Fix infrastructure'], f.project);
  await git(['merge', '--ff-only', 'main'], blocked.worktree);
  let built = false;
  const result = await resumeJob(f.home, f.repo, job.id, { runRole: async args => {
    if (args.role === 'builder') { built = true; await writeFile(join(args.worktree, 'app.txt'), 'feature implemented\n'); }
    return report(args);
  }, deliver: async state => ({ url: 'https://example.invalid/pr', head: state.commit }) });
  assert.equal(result.stage, 'ready', result.blocker);
  assert.equal(built, true);
  assert.equal(result.round, 2);
  assert.equal(await readFile(join(result.worktree, 'app.txt'), 'utf8'), 'feature implemented\n');
});
