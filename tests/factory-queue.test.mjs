import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './factory-fixture.mjs';
import { command } from '../skills/ready/cc/scripts/factory.mjs';
import { execute } from '../skills/ready/cc/scripts/factory/io.mjs';
import { listJobs } from '../skills/ready/cc/scripts/factory/store.mjs';

test('issue run freezes a snapshot, persists mappings, isolates blocked jobs, and skips duplicates', async t => {
 const f = await fixture(t, {github:true});
 let issues = [1,2];
 const dependencies = {
  skipLabels: true,
  deliver: async state => ({ url: `https://github.com/fixture/cc-factory/pull/${state.issue.number}`, head: state.commit }),
  run: async (file,args,options) => {
   if(file === 'git' && args[0] === 'fetch') return {code:0,stdout:''};
   if(file !== 'gh') return execute(file,args,options);
   if(args[0] === 'repo') return {code:0,stdout:JSON.stringify({nameWithOwner:'fixture/cc-factory'})};
   if(args[0] === 'api') return {code:0,stdout:JSON.stringify(/[?&]page=1$/.test(args[1]) ? issues.map(number => ({number,title:`Issue ${number}`,body:'Exact body with `literal` characters',html_url:`https://github.com/fixture/cc-factory/issues/${number}`,state:'open'})) : [])};
   return {code:0,stdout:''};
  },
  runRole: async ({role,commit,worktree,job}) => {
   issues = [1,2,3];
   if(role === 'builder') await writeFile(join(worktree,'app.txt'),'after\n');
   return {verdict:role === 'intake' ? 'ACCEPT' : role === 'spec' && job.issue.number === 2 ? 'BLOCKED' : role === 'approver' ? 'APPROVE' : role.startsWith('review-') ? 'PASS' : 'READY',commit,findings:[],evidence:['fixture'],artifact:'# Specification or plan'};
  }
 };
 const first = await command('run',{home:f.home,repo:f.repo,host:'codex'},dependencies);
 assert.deepEqual(first.snapshot.issues,[1,2]);
 assert.equal(first.results[0].value.stage,'ready');
 assert.equal(first.results[1].value.stage,'blocked');
 assert.equal((await listJobs(f.home,f.repo)).length,2);
 assert.equal(await readFile(join(first.results[0].value.directory,'request.md'),'utf8'),'Issue 1\n\nExact body with `literal` characters');
 issues = [1,2];
 const repeated = await command('run',{home:f.home,repo:f.repo,host:'codex'},dependencies);
 assert.deepEqual(repeated.snapshot.jobs,[]);
 assert.deepEqual(repeated.snapshot.skipped,[1,2]);
});
