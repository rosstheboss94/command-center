import test from 'node:test';
import assert from 'node:assert/strict';
import { ownership, selectSkills } from '../skills/ready/cc/scripts/skill-policy.mjs';
import { buildCatalog } from '../skills/ready/cc/scripts/inspection.mjs';
import { fileURLToPath } from 'node:url';

test('all bundled names have exactly one normative workflow owner', () => {
  assert.deepEqual(ownership, {
    'interview-me': 'intake', 'idea-refine': 'intake',
    'spec-driven-development': 'spec', 'constraint-driven-development': 'spec',
    'planning-and-task-breakdown': 'plan',
    'incremental-implementation': 'build', 'frontend-ui-engineering': 'build', 'api-and-interface-design': 'build', 'code-simplification': 'build', 'observability-and-instrumentation': 'build',
    'test-driven-development': 'verify', 'browser-testing-with-devtools': 'verify', 'debugging-and-error-recovery': 'verify',
    'code-review-and-quality': 'review', 'security-and-hardening': 'review', 'performance-optimization': 'review', 'accessibility-engineering': 'review',
    'doubt-driven-development': 'approve',
    'git-workflow-and-versioning': 'deliver', 'ci-cd-and-automation': 'deliver', 'deprecation-and-migration': 'deliver', 'documentation-and-adrs': 'deliver', 'shipping-and-launch': 'deliver',
    cc: 'ready', 'using-agent-skills': 'ready', 'context-engineering': 'ready', 'source-driven-development': 'ready',
  });
});
test('the canonical repository resolves all 27 names at their normative nested paths', async () => {
  const catalog = await buildCatalog(fileURLToPath(new URL('../', import.meta.url)));
  assert.deepEqual(catalog.diagnostics, []);
  assert.equal(catalog.skills.length, 27);
  assert.deepEqual(Object.fromEntries(catalog.skills.map(item => [item.name, item.workflowStep])), ownership);
  assert.ok(catalog.skills.every(item => item.valid && item.layout === 'nested' && item.path === `skills/${ownership[item.name]}/${item.name}/SKILL.md`));
});
const expectedRoles = {
  intake: 'interview-me idea-refine',
  spec: 'spec-driven-development constraint-driven-development api-and-interface-design deprecation-and-migration security-and-hardening',
  plan: 'planning-and-task-breakdown incremental-implementation test-driven-development',
  builder: 'incremental-implementation frontend-ui-engineering api-and-interface-design code-simplification observability-and-instrumentation test-driven-development browser-testing-with-devtools debugging-and-error-recovery security-and-hardening accessibility-engineering performance-optimization git-workflow-and-versioning ci-cd-and-automation deprecation-and-migration documentation-and-adrs doubt-driven-development',
  'review-code': 'code-review-and-quality code-simplification test-driven-development api-and-interface-design',
  'review-security': 'security-and-hardening code-review-and-quality',
  'review-ui': 'frontend-ui-engineering accessibility-engineering browser-testing-with-devtools',
  'review-ux': 'accessibility-engineering frontend-ui-engineering code-review-and-quality',
  approver: 'doubt-driven-development code-review-and-quality shipping-and-launch',
};
for (const [role, additional] of Object.entries(expectedRoles)) test(`${role} receives its exact documented default set`, () => {
  const catalog = Object.keys(ownership).map(name => ({ name, valid: true }));
  const expected = [...additional.split(' '), 'using-agent-skills', 'context-engineering', 'source-driven-development'].sort();
  assert.deepEqual(selectSkills(catalog, role).map(item => item.name), expected);
});
test('custom saved names retain unknown ownership and recovery adds debugging guidance', () => {
  const catalog = [...Object.keys(ownership).map(name => ({ name, valid: true })), { name: 'custom', workflowStep: null, valid: true }];
  const selected = selectSkills(catalog, 'spec', ['custom'], { recovery: true });
  assert.equal(selected.find(item => item.name === 'custom').workflowStep, null);
  assert.match(selected.find(item => item.name === 'debugging-and-error-recovery').selectionReason, /recovery/);
  assert.throws(() => selectSkills(catalog, 'rejected'), /role/);
  assert.throws(() => selectSkills(catalog, 'intake', ['missing']), /missing/);
});
test('role subsets include cross-cutting guidance and explicit additions without automatic cc', () => {
  const catalog = Object.entries(ownership).map(([name, workflowStep]) => ({ name, workflowStep, valid: true }));
  const selected = selectSkills(catalog, 'intake', ['cc']);
  assert.deepEqual(selected.map(item => item.name), ['cc', 'context-engineering', 'idea-refine', 'interview-me', 'source-driven-development', 'using-agent-skills']);
  assert.equal(selectSkills(catalog, 'builder').some(item => item.name === 'cc'), false);
  assert.throws(() => selectSkills([...catalog, catalog[0]], 'intake', [catalog[0].name]), /ambiguous/i);
  assert.throws(() => selectSkills(catalog, 'blocked'), /role/i);
});
