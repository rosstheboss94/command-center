import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './factory-fixture.mjs';
import { loadContext, saveConfig } from '../skills/cc/scripts/factory/project.mjs';
import { createJob, loadJob } from '../skills/cc/scripts/factory/store.mjs';
import { runJob, feedback, recover, restartChoiceLine } from '../skills/cc/scripts/factory/engine.mjs';
import { git, execute, inside } from '../skills/cc/scripts/factory/io.mjs';
import { restartOptions, blockCommentBody } from '../skills/cc/scripts/factory/github.mjs';

test('registered project checks and scoped instructions are frozen; config drift blocks new jobs', async t => {
  const f = await fixture(t);
  const context = await loadContext(f.home, f.repo, 'codex');
  assert.equal(context.checks[0].command, 'npm test');
  assert.equal(context.instructions[0].path, 'AGENTS.md');
  await saveConfig(f.home, f.repo, { concurrency: 2 }, 'codex');
  assert.equal((await loadContext(f.home, f.repo, 'codex')).config.concurrency, 2);
  await saveConfig(f.home, f.repo, { roles: { builder: { runner: 'grok' } } }, 'codex');
  assert.equal((await loadContext(f.home, f.repo, 'codex')).config.concurrency, 2);
  const configPath = join(f.home, 'repos', f.repo, 'config.md');
  await writeFile(configPath, (await readFile(configPath, 'utf8')) + '\nChanged settings\n');
  await assert.rejects(loadContext(f.home, f.repo, 'codex'), /reconcile/i);
});

function roleRunner({ changes = false, blocked = false, mutateReview = false } = {}) {
  let reviewCount = 0;
  return async ({ role, commit, worktree }) => {
    if (role === 'builder') await writeFile(join(worktree, 'app.txt'), 'after\n');
    if (mutateReview && role === 'review-code') await writeFile(join(worktree, 'app.txt'), 'bad review write\n');
    const verdict = role === 'intake' ? 'ACCEPT' : role === 'approver' ? 'APPROVE' : role.startsWith('review-')
      ? changes && reviewCount++ === 0 ? 'CHANGES' : 'PASS' : blocked && role === 'spec' ? 'BLOCKED' : 'READY';
    return { verdict, commit, findings: verdict === 'CHANGES' ? ['fix it'] : [], evidence: ['fixture inspected runtime'], artifact: '# Verified fixture artifact' };
  };
}

test('end-to-end local job isolates changes and reaches delivery only after current reviews and approval', async t => {
  const f = await fixture(t); const context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Change app');
  const seen = [];
  const runRole = roleRunner({ changes: true });
  const result = await runJob(f.home, f.repo, job.id, { runRole: async args => { seen.push(args.role); return runRole(args); }, deliver: async state => ({ url: 'https://example.invalid/pr/1', head: state.commit }) });
  assert.equal(result.stage, 'ready'); assert.equal(result.round, 2);
  assert.equal(await readFile(join(f.project, 'app.txt'), 'utf8'), 'before\n');
  assert.equal(await readFile(join(result.worktree, 'app.txt'), 'utf8'), 'after\n');
  assert.ok(seen.indexOf('review-code') > seen.indexOf('builder'));
  assert.ok(seen.includes('approver'));
  assert.equal(result.checks.commit, result.commit);
  assert.equal(result.reports['review-code'].commit, result.commit);
});

test('role failures block without switching provider; feedback resumes the interrupted stage', async t => {
  const f = await fixture(t); const context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Change app');
  let result = await runJob(f.home, f.repo, job.id, { runRole: roleRunner({ blocked: true }) });
  assert.equal(result.stage, 'blocked'); assert.equal(result.interruptedStage, 'spec');
  const resumed = await feedback(f.home, f.repo, job.id, 'Proceed with the original acceptance criteria.');
  assert.equal(resumed.restartChoice, null);
  assert.equal(resumed.feedback.at(-1).restartOption, undefined);
  assert.equal(resumed.history.at(-1).message, 'Recorded user feedback and restored interrupted stage.');
  result = await runJob(f.home, f.repo, job.id, { runRole: roleRunner(), deliver: async state => ({ url: 'https://example.invalid/pr/2', head: state.commit }) });
  assert.equal(result.stage, 'ready');
  assert.equal(result.restartChoice, null);
});

test('read-only role writes and protected builder edits fail gates', async t => {
  const f = await fixture(t); const context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Change app');
  const result = await runJob(f.home, f.repo, job.id, { runRole: roleRunner({ mutateReview: true }) });
  assert.equal(result.stage, 'blocked'); assert.match(result.blocker, /read-only/i);
});

test('stale commits on resume invalidate check, review and approval evidence', async t => {
  const f = await fixture(t); const context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Change app');
  let result = await runJob(f.home, f.repo, job.id, { runRole: roleRunner(), deliver: async () => { throw new Error('network offline'); } });
  assert.equal(result.stage, 'blocked'); assert.equal(result.interruptedStage, 'deliver');
  await writeFile(join(result.worktree, 'app.txt'), 'manual fix\n');
  await git(['add', 'app.txt'], result.worktree); await git(['commit', '-m', 'manual fix'], result.worktree);
  result = await command('resume', { home: f.home, repo: f.repo, job: job.id }, { runRole: roleRunner(), deliver: async state => ({ url: 'https://example.invalid/pr/3', head: state.commit }) });
  assert.equal(result.stage, 'ready');
  assert.equal(result.checks.commit, result.commit);
  assert.ok(result.reports.spec?.artifact);
});

test('live repository leases enforce the stricter limit across separately frozen configurations', async t => {
  const f = await fixture(t); const context = await loadContext(f.home, f.repo, 'codex');
  context.config.concurrency = 1;
  const first = await createJob(context, 'first');
  let started;
  const running = new Promise(resolve => { started = resolve; });
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const firstRun = runJob(f.home, f.repo, first.id, { runRole: async ({ commit }) => {
    started(); await wait;
    return { verdict: 'NEEDS_INFO', commit, findings: ['Need user'], evidence: ['inspected task'] };
  } });
  await running;
  context.config.concurrency = 3;
  const second = await createJob(context, 'second');
  try {
    await assert.rejects(runJob(f.home, f.repo, second.id, { runRole: async () => { throw new Error('must not dispatch'); } }), /concurrency/);
  } finally { release(); await firstRun; }
});

test('recovery refuses live owners and dirty check output blocks instead of becoming passing evidence', async t => {
  const f = await fixture(t); const context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Change app');
  await writeFile(join(job.directory, 'execution.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(recover(f.home, f.repo, job.id), /still live/);
  const { unlink } = await import('node:fs/promises');
  await unlink(join(job.directory, 'execution.lock'));
  const result = await runJob(f.home, f.repo, job.id, { runRole: roleRunner(), run: async (file, args, options) => {
    if (file === 'npm') { await writeFile(join(options.cwd, 'app.txt'), 'changed by tests'); return { code: 0, stdout: '', stderr: '' }; }
    return execute(file, args, options);
  } });
  assert.equal(result.stage, 'blocked');
  assert.match(result.blocker, /Checks modified/);
  assert.notEqual(result.checks?.passed, true);
});

test('UI jobs require actual rendered evidence before they can reach reviews', async t => {
  const f = await fixture(t); const context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Add UI'); const normal = roleRunner();
  const result = await runJob(f.home, f.repo, job.id, { runRole: async args => {
    if (args.role === 'builder') await writeFile(join(args.worktree, 'app.html'), '<h1>App</h1>');
    return normal(args);
  } });
  assert.equal(result.stage, 'blocked'); assert.match(result.blocker, /visual evidence/);
});

test('builders cannot commit factory control edits and failing checks exhaust the frozen budget', async t => {
  const f = await fixture(t); const context = await loadContext(f.home, f.repo, 'codex');
  const job = await createJob(context, 'Change app');
  const normal = roleRunner();
  const protectedJob = await runJob(f.home, f.repo, job.id, { runRole: async args => {
    if (args.role === 'builder') {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(args.worktree, 'repos'));
      await writeFile(join(args.worktree, 'repos/control.json'), '{}');
    }
    return normal(args);
  } });
  assert.match(protectedJob.blocker, /protected factory controls/);
  context.config.maxRounds = 2;
  const failing = await createJob(context, 'A failing check');
  const result = await runJob(f.home, f.repo, failing.id, { runRole: normal, run: async (file, args, options) => file === 'npm'
    ? { code: 1, stdout: 'failure', stderr: '' } : execute(file, args, options) });
  assert.equal(result.stage, 'blocked'); assert.equal(result.round, 2);
  assert.match(result.blocker, /budget exhausted/);
});

for (const runner of ['codex', 'claude', 'grok']) test(`real engine normalizes ${runner} dispatch and saves attempt logs`, async t => {
  const f = await fixture(t); const context = await loadContext(f.home, f.repo, runner);
  const job = await createJob(context, 'Change app'); const normal = roleRunner();
  const result = await runJob(f.home, f.repo, job.id, { deliver: async state => ({ url: 'https://example.invalid/pr/4', head: state.commit }),
    run: async (file, args, options) => {
      if (file !== runner) return execute(file, args, options);
      const prompt = runner === 'grok' ? await readFile(args[args.indexOf('--prompt-file') + 1], 'utf8') : options.input;
      const role = /^ROLE: (.+)$/m.exec(prompt)[1]; const commit = /^COMMIT: (.+)$/m.exec(prompt)[1];
      await options.onStart(process.pid);
      const report = await normal({ role, commit, worktree: options.cwd });
      const text = JSON.stringify(report);
      const stdout = runner === 'codex' ? [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }), JSON.stringify({ type: 'turn.completed' })].join('\n')
        : runner === 'grok' ? JSON.stringify({ text, stopReason: 'end_turn' }) : JSON.stringify({ type: 'result', subtype: 'success', result: text });
      return { code: 0, stdout, stderr: '' };
    } });
  assert.equal(result.stage, 'ready', result.blocker);
  assert.ok(result.attempts.some(attempt => attempt.name === 'review-code' && attempt.finished));
});

import { command } from '../skills/cc/scripts/factory.mjs';
import { saveJob, listJobs } from '../skills/cc/scripts/factory/store.mjs';

test('legacy CLI adoption validates the worktree and refreshes all old evidence', async t => {
 const f = await fixture(t); const { mkdir } = await import('node:fs/promises');
 const directory = join(f.home,'jobs',f.repo,'legacy'); await mkdir(directory,{recursive:true});
 await writeFile(join(directory,'progress.md'),'Old progress and claimed review');
 await writeFile(join(directory,'request.md'),'Original legacy request');
 const worktree = join(f.root,'legacy-worktree');
 await git(['worktree','add','-b','legacy-job',worktree,'main'],f.project);
 const adopted = await command('adopt',{home:f.home,repo:f.repo,job:'legacy',host:'codex',worktree});
 assert.equal(adopted.stage,'blocked'); assert.equal(adopted.requiresFeedback,true);
 assert.deepEqual(adopted.reports,{});
 const file = join(f.root,'feedback.txt'); await writeFile(file,'Confirm the original request and existing isolated branch.');
 const result = await command('feedback',{home:f.home,repo:f.repo,job:'legacy',file},{runRole:roleRunner(),deliver:async state=>({url:'https://example.invalid/pr/5',head:state.commit})});
 assert.equal(result.stage,'ready',result.blocker);
 assert.equal(result.restartChoice, null);
 assert.equal(await readFile(join(directory,'legacy-progress.md'),'utf8'),'Old progress and claimed review');
});

test('stale recovery refuses live children before clearing exact owned locks', async t => {
 const f = await fixture(t); const context = await loadContext(f.home,f.repo,'codex');
 const job = await createJob(context,'Recovery request');
 const dead = await execute(process.execPath,['-e','console.log(process.pid)']);
 const pid = Number(dead.stdout.trim());
 await writeFile(join(job.directory,'execution.lock'),JSON.stringify({pid}));
 job.attempts.push({childPid:process.pid,ownerPid:pid}); await saveJob(job,'fixture interrupted child');
 await assert.rejects(recover(f.home,f.repo,job.id),/still live/);
 job.attempts[0].finished = new Date().toISOString(); await saveJob(job,'fixture child finished');
 const recovered = await recover(f.home,f.repo,job.id);
 assert.equal(recovered.stage,'blocked'); assert.equal(recovered.requiresFeedback,true);
 assert.equal(recovered.interruptedStage,'intake');
});

const selfRepo = 'https://github.com/rosstheboss94/command-center.git';
const allowLocalFetch = (file,args,options) => file === 'git' && args[0] === 'fetch' ? Promise.resolve({code:0,stdout:''}) : execute(file,args,options);
async function sourceBuilder(args) {
 const { mkdir } = await import('node:fs/promises');
 if(args.role === 'builder') {
  await mkdir(join(args.worktree,'skills/cc/scripts'),{recursive:true});
  await writeFile(join(args.worktree,'skills/cc/scripts/checks.mjs'),'// owned source change\n');
 }
 return roleRunner()(args);
}
test('Command Center self-jobs may update source but cannot modify the live home controls', async t => {
 const f = await fixture(t,{github:selfRepo}); const context = await loadContext(f.home,f.repo,'codex');
 const job = await createJob(context,'Update Command Center validator');
 const result = await runJob(f.home,f.repo,job.id,{run:allowLocalFetch,runRole:sourceBuilder,deliver:async state=>({url:'https://example.invalid/self-pr',head:state.commit})});
 assert.equal(result.stage,'ready',result.blocker);
 const other = await createJob(context,'Malicious live-control edit');
 const blocked = await runJob(f.home,f.repo,other.id,{run:allowLocalFetch,runRole:async args=>{
  if(args.role === 'builder') await writeFile(join(f.home,'skills/cc/SKILL.md'),'tampered live control');
  return sourceBuilder(args);
 }});
 assert.equal(blocked.stage,'blocked'); assert.match(blocked.blocker,/protected factory controls/);
});
test('explicit recovery checkpoints a completed preserved build without redispatching or skipping checks', async t => {
 const f = await fixture(t,{github:selfRepo}); const context = await loadContext(f.home,f.repo,'codex');
 const job = await createJob(context,'Update Command Center validator');
 const stopped = await runJob(f.home,f.repo,job.id,{runRole:sourceBuilder,run:async(file,args,options)=>file==='git'&&args[0]==='commit'?{code:1,stderr:'fixture interruption'}:allowLocalFetch(file,args,options)});
 assert.equal(stopped.stage,'blocked'); assert.equal(stopped.reports.builder.verdict,'READY');
 const recovered = await command('resume',{home:f.home,repo:f.repo,job:job.id,'accept-build':true},{run:allowLocalFetch,runRole:async args=>{
  assert.notEqual(args.role,'builder'); return roleRunner()(args);
 },deliver:async state=>({url:'https://example.invalid/recovered-pr',head:state.commit})});
 assert.equal(recovered.stage,'ready',recovered.blocker); assert.equal(recovered.round,1);
 assert.equal(recovered.restartChoice, null);
 assert.equal(recovered.checks.passed,true); assert.equal(recovered.checks.commit,recovered.commit);
 assert.equal(await readFile(join(recovered.worktree,'skills/cc/scripts/checks.mjs'),'utf8'),'// owned source change\n');
});

test('checkpoint recovery rejects edits made after the accepted builder report', async t => {
 const f = await fixture(t,{github:selfRepo}); const context = await loadContext(f.home,f.repo,'codex');
 const job = await createJob(context,'Update Command Center validator');
 const stopped = await runJob(f.home,f.repo,job.id,{runRole:sourceBuilder,run:async(file,args,options)=>file==='git'&&args[0]==='commit'?{code:1,stderr:'fixture interruption'}:allowLocalFetch(file,args,options)});
 await writeFile(join(stopped.worktree,'app.txt'),'unexpected later edits');
 await assert.rejects(command('resume',{home:f.home,repo:f.repo,job:job.id,'accept-build':true},{run:allowLocalFetch}),/changed after the completed builder report/);
 assert.equal((await loadJob(f.home,f.repo,job.id)).stage,'blocked');
});

function githubRunner() {
  const calls = [];
  const modes = new Map();
  const sequence = [];
  const run = async (file, args, options) => {
    if (file === 'git' && args[0] === 'fetch') return { code: 0, stdout: '' };
    if (file !== 'gh') return execute(file, args, options);
    calls.push(args);
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'fixture/cc-factory' }) };
    if (args[0] === 'label') return { code: 0, stdout: '' };
    if (args[0] === 'issue' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ labels: [{ name: 'cc:running' }] }) };
    if (args[0] === 'issue' && args[1] === 'edit') {
      if (args.includes('--add-label')) sequence.push(`label:${args[2]}`);
      return { code: 0, stdout: '' };
    }
    if (args[0] === 'issue' && args[1] === 'comment') {
      sequence.push(`comment:${args[2]}`);
      const mode = modes.get(args[2]) || 'ok';
      if (mode === 'fail') return { code: 1, stderr: 'comment denied', stdout: '' };
      if (mode === 'bad-url') return { code: 0, stdout: 'https://github.com/evil/other/issues/1#issuecomment-1' };
      return { code: 0, stdout: `https://github.com/fixture/cc-factory/issues/${args[2]}#issuecomment-4\n` };
    }
    return { code: 0, stdout: '' };
  };
  const comments = number => calls.filter(args => args[0] === 'issue' && args[1] === 'comment' && args[2] === String(number));
  return { calls, modes, sequence, run, comments };
}
const deliver = async state => ({ url: 'https://example.invalid/pr/blocked-comment', head: state.commit });
function blockSpec({ role, commit }) {
  if (role === 'spec') return { verdict: 'BLOCKED', commit, findings: ['need a narrower change'], evidence: ['spec inspected'] };
  const verdict = role === 'intake' ? 'ACCEPT' : 'READY';
  return { verdict, commit, findings: [], evidence: ['fixture inspected'], artifact: '# Verified fixture artifact' };
}

test('one new block posts one comment and an exact letter resumes that same job', async t => {
  const f = await fixture(t, { github: true });
  const context = await loadContext(f.home, f.repo, 'grok');
  const github = githubRunner();
  const once = await createJob(context, 'Comment once', { issue: { number: 41, url: 'https://github.com/fixture/cc-factory/issues/41' } });
  const blocked = await runJob(f.home, f.repo, once.id, { skipLabels: true, run: github.run, runRole: blockSpec });
  assert.equal(blocked.stage, 'blocked');
  assert.equal(blocked.interruptedStage, 'spec');
  assert.equal(blocked.blocker, 'need a narrower change');
  assert.equal(blocked.schemaVersion, 1);
  assert.equal(blocked.commentError, undefined);
  assert.equal(blocked.restartChoice, null);
  assert.equal(github.comments(41).length, 1);
  assert.deepEqual(github.comments(41)[0], ['issue', 'comment', '41', '--repo', 'fixture/cc-factory', '--body-file', join(blocked.directory, 'block-comment.md')]);
  const bodyPath = join(blocked.directory, 'block-comment.md');
  const body = await readFile(bodyPath, 'utf8');
  assert.equal(body, blockCommentBody({ id: blocked.id, repo: blocked.repo, stage: 'spec', blocker: blocked.blocker }));
  assert.equal(inside(blocked.worktree, bodyPath), false);
  assert.equal(github.sequence.some(item => item.startsWith('label:')), false);
  const written = await stat(bodyPath);
  const dead = await execute(process.execPath, ['-e', 'console.log(process.pid)']);
  await writeFile(join(blocked.directory, 'execution.lock'), JSON.stringify({ pid: Number(dead.stdout.trim()) }));
  const recovered = await recover(f.home, f.repo, once.id, { run: github.run });
  assert.equal(recovered.stage, 'blocked');
  assert.equal(github.comments(41).length, 1);
  assert.equal(await readFile(bodyPath, 'utf8'), body);
  assert.equal((await stat(bodyPath)).mtimeMs, written.mtimeMs);

  const letter = await createJob(context, 'Choose b', { issue: { number: 42, url: 'https://github.com/fixture/cc-factory/issues/42' } });
  let specBlocked = true;
  const first = await runJob(f.home, f.repo, letter.id, { skipLabels: true, run: github.run, runRole: async args => {
    if (args.role === 'spec' && specBlocked) { specBlocked = false; return blockSpec(args); }
    return roleRunner()(args);
  } });
  const choice = restartOptions(first.interruptedStage, first.blocker).b;
  const resumed = await feedback(f.home, f.repo, letter.id, 'b\n');
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.stage, 'spec');
  assert.equal(resumed.round, first.round);
  assert.deepEqual(resumed.frozen, first.frozen);
  assert.deepEqual(resumed.requiredReviews, first.requiredReviews);
  assert.equal(resumed.issue.number, 42);
  assert.deepEqual(resumed.restartChoice, { letter: 'b', text: choice, stage: 'spec' });
  assert.equal(resumed.feedback.at(-1).text, 'b\n');
  assert.deepEqual(resumed.feedback.at(-1).restartOption, { letter: 'b', text: choice });
  assert.equal(resumed.history.at(-1).message, 'Recorded restart option b and restored interrupted stage.');
  const seen = [];
  const done = await runJob(f.home, f.repo, letter.id, { skipLabels: true, deliver, run: async (file, args, options) => {
    if (file !== 'grok') return github.run(file, args, options);
    const prompt = await readFile(args[args.indexOf('--prompt-file') + 1], 'utf8');
    const lines = prompt.split('\n');
    const feedbackLine = lines.findIndex(line => line.startsWith('Feedback: '));
    assert.equal(lines[feedbackLine + 1], restartChoiceLine(resumed));
    for (const arg of args) assert.equal(arg.includes(choice), false);
    seen.push(/^ROLE: (.+)$/m.exec(prompt)[1]);
    await options.onStart(process.pid);
    const report = await roleRunner()({ role: seen.at(-1), commit: /^COMMIT: (.+)$/m.exec(prompt)[1], worktree: options.cwd });
    return { code: 0, stdout: JSON.stringify({ text: JSON.stringify(report), stopReason: 'end_turn' }), stderr: '' };
  } });
  assert.equal(seen[0], 'spec');
  assert.equal(done.id, letter.id);
  assert.equal(done.stage, 'ready', done.blocker);
  assert.equal((await listJobs(f.home, f.repo)).length, 2);
  assert.equal(github.calls.some(args => args[0] === 'issue' && args[1] === 'create'), false);
  const ready = await command('status', { home: f.home, repo: f.repo, job: done.id });
  assert.equal(ready.warnings.some(warning => warning.startsWith('GitHub block comment failed:')), false);

  const again = await createJob(context, 'Comment again', { issue: { number: 43, url: 'https://github.com/fixture/cc-factory/issues/43' } });
  github.modes.set('43', 'fail');
  const failed = await runJob(f.home, f.repo, again.id, { skipLabels: true, run: github.run, runRole: blockSpec });
  assert.equal(failed.commentError, 'GitHub issue failed: comment denied');
  const selected = await feedback(f.home, f.repo, again.id, 'c\n');
  assert.equal(selected.restartChoice.letter, 'c');
  assert.equal(selected.commentError, failed.commentError);
  github.modes.set('43', 'ok');
  const second = await runJob(f.home, f.repo, again.id, { skipLabels: true, run: github.run, runRole: blockSpec });
  assert.equal(second.stage, 'blocked');
  assert.equal(second.restartChoice, null);
  assert.equal(second.commentError, undefined);
  assert.equal(github.comments(43).length, 2);
  assert.equal(await readFile(join(second.directory, 'block-comment.md'), 'utf8'), blockCommentBody({ id: second.id, repo: second.repo, stage: second.interruptedStage, blocker: second.blocker }));
});

test('a failed block comment stays local and status reports it', async t => {
  const f = await fixture(t, { github: true });
  const context = await loadContext(f.home, f.repo, 'codex');
  const github = githubRunner();
  github.modes.set('51', 'fail');
  const denied = await createJob(context, 'Denied comment', { issue: { number: 51, url: 'https://github.com/fixture/cc-factory/issues/51' } });
  const failed = await runJob(f.home, f.repo, denied.id, { run: github.run, runRole: blockSpec });
  assert.equal(failed.stage, 'blocked');
  assert.equal(failed.blocker, 'need a narrower change');
  assert.equal(failed.commentError, 'GitHub issue failed: comment denied');
  assert.equal(failed.history.some(item => item.message.startsWith('Posted one blocked-job comment')), false);
  assert.equal(failed.history.some(item => item.message === 'GitHub block comment failed: GitHub issue failed: comment denied'), true);
  const deniedOrder = github.sequence.filter(item => item.endsWith(':51'));
  assert.ok(deniedOrder.lastIndexOf('label:51') > deniedOrder.lastIndexOf('comment:51'));
  github.modes.set('52', 'bad-url');
  const mismatched = await createJob(context, 'Mismatched comment', { issue: { number: 52, url: 'https://github.com/fixture/cc-factory/issues/52' } });
  const bad = await runJob(f.home, f.repo, mismatched.id, { skipLabels: true, run: github.run, runRole: blockSpec });
  assert.equal(bad.stage, 'blocked');
  assert.equal(bad.blocker, 'need a narrower change');
  assert.equal(bad.commentError, 'GitHub issue comment response did not match issue 52.');
  assert.equal(bad.history.some(item => item.message.startsWith('Posted one blocked-job comment')), false);
  assert.equal(github.sequence.some(item => item === 'label:52'), false);
  for (const job of [failed, bad]) {
    const status = await command('status', { home: f.home, repo: f.repo, job: job.id });
    assert.equal(status.warnings.includes(`GitHub block comment failed: ${job.commentError}`), true);
  }
  failed.labelError = 'label broke';
  await saveJob(failed, 'fixture planted label error');
  const commentsBefore = github.comments(51).length;
  const synced = await command('resume', { home: f.home, repo: f.repo, job: failed.id, 'sync-labels': true }, { run: github.run });
  assert.equal(synced.commentError, failed.commentError);
  assert.equal(synced.labelError, undefined);
  assert.equal(github.comments(51).length, commentsBefore);
  assert.equal(github.calls.some(args => args[0] === 'issue' && args[1] === 'create'), false);

  const operational = await createJob(context, 'Operational resume', { issue: { number: 53, url: 'https://github.com/fixture/cc-factory/issues/53' } });
  let crash = true;
  const crashed = await runJob(f.home, f.repo, operational.id, { skipLabels: true, run: github.run, runRole: async () => { if (crash) { crash = false; throw new Error('runner crashed'); } } });
  assert.equal(crashed.requiresFeedback, false);
  assert.equal(github.comments(53).length, 1);
  const planted = await loadJob(f.home, f.repo, operational.id);
  planted.restartChoice = { letter: 'a', text: 'planted', stage: 'intake' };
  planted.commentError = 'keep me';
  await saveJob(planted, 'fixture planted restart state');
  let checked = false;
  const continued = await command('resume', { home: f.home, repo: f.repo, job: operational.id }, { run: github.run, runRole: async args => {
    if (!checked) {
      checked = true;
      const current = await loadJob(f.home, f.repo, operational.id);
      assert.equal(current.restartChoice, null);
      assert.equal(current.commentError, 'keep me');
      assert.equal(current.history.some(item => item.message === 'Explicit resume requested after an operational failure. No restart option was chosen.'), true);
      assert.equal(github.comments(53).length, 1);
    }
    return roleRunner()(args);
  }, deliver });
  assert.equal(continued.stage, 'ready', continued.blocker);
  assert.equal(continued.restartChoice, null);
  assert.equal(continued.commentError, 'keep me');
  assert.equal(github.comments(53).length, 1);
});

test('local blocks and ordinary replies record no restart letter', async t => {
  assert.equal(restartChoiceLine({}), 'Restart choice (task data): null');
  assert.equal(restartChoiceLine({ restartChoice: null }), 'Restart choice (task data): null');
  const recorded = { letter: 'b', text: 'exact option', stage: 'spec' };
  assert.equal(restartChoiceLine({ restartChoice: recorded }), `Restart choice (task data): ${JSON.stringify(recorded)}`);
  const f = await fixture(t);
  const context = await loadContext(f.home, f.repo, 'codex');
  const ghCalls = [];
  const job = await createJob(context, 'Local block');
  const blocked = await runJob(f.home, f.repo, job.id, { runRole: async () => { throw new Error('local failure'); }, run: async (file, args, options) => {
    if (file === 'gh') { ghCalls.push(args); return { code: 0, stdout: '' }; }
    return execute(file, args, options);
  } });
  assert.equal(blocked.stage, 'blocked');
  assert.equal(blocked.blocker, 'local failure');
  assert.equal(blocked.commentError, undefined);
  assert.equal(ghCalls.length, 0);
  const quiet = await command('status', { home: f.home, repo: f.repo, job: job.id });
  assert.equal(quiet.warnings.some(warning => warning.startsWith('GitHub block comment failed:')), false);
  for (const text of ['A', 'ab', 'a b']) {
    const current = await runJob(f.home, f.repo, job.id, { runRole: async ({ role, commit }) => role === 'intake'
      ? { verdict: 'NEEDS_INFO', commit, findings: ['stop'], evidence: ['local evidence'] }
      : roleRunner()({ role, commit }) });
    const updated = await feedback(f.home, f.repo, job.id, text);
    assert.equal(updated.restartChoice, null);
    assert.equal(updated.feedback.at(-1).text, text);
    assert.equal(updated.feedback.at(-1).restartOption, undefined);
    assert.equal(updated.history.at(-1).message, 'Recorded user feedback and restored interrupted stage.');
    assert.equal(updated.history.some(item => item.message.includes('Recorded restart option')), false);
    assert.equal(current.stage, 'blocked');
  }
});
