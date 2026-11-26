// Canonical ownership is maintenance responsibility, not exclusive availability.
export const stages = ['intake', 'spec', 'plan', 'build', 'verify', 'review', 'approve', 'deliver', 'ready'];
const owned = {
  intake: ['interview-me', 'idea-refine'],
  spec: ['spec-driven-development', 'constraint-driven-development'],
  plan: ['planning-and-task-breakdown'],
  build: ['incremental-implementation', 'frontend-ui-engineering', 'api-and-interface-design', 'code-simplification', 'observability-and-instrumentation'],
  verify: ['test-driven-development', 'browser-testing-with-devtools', 'debugging-and-error-recovery'],
  review: ['code-review-and-quality', 'security-and-hardening', 'performance-optimization', 'accessibility-engineering'],
  approve: ['doubt-driven-development'],
  deliver: ['git-workflow-and-versioning', 'ci-cd-and-automation', 'deprecation-and-migration', 'documentation-and-adrs', 'shipping-and-launch'],
  ready: ['cc', 'using-agent-skills', 'context-engineering', 'source-driven-development'],
};
export const ownership = Object.freeze(Object.fromEntries(Object.entries(owned).flatMap(([step, names]) => names.map(name => [name, step]))));
const crossCutting = ['using-agent-skills', 'context-engineering', 'source-driven-development'];
const roles = {
  intake: owned.intake,
  spec: [...owned.spec, 'api-and-interface-design', 'deprecation-and-migration', 'security-and-hardening'],
  plan: ['planning-and-task-breakdown', 'incremental-implementation', 'test-driven-development'],
  builder: [...owned.build, ...owned.verify, 'security-and-hardening', 'accessibility-engineering', 'performance-optimization', 'git-workflow-and-versioning', 'ci-cd-and-automation', 'deprecation-and-migration', 'documentation-and-adrs', 'doubt-driven-development'],
  'review-code': ['code-review-and-quality', 'code-simplification', 'test-driven-development', 'api-and-interface-design'],
  'review-security': ['security-and-hardening', 'code-review-and-quality'],
  'review-ui': ['frontend-ui-engineering', 'accessibility-engineering', 'browser-testing-with-devtools'],
  'review-ux': ['accessibility-engineering', 'frontend-ui-engineering', 'code-review-and-quality'],
  approver: ['doubt-driven-development', 'code-review-and-quality', 'shipping-and-launch'],
};
export const skillPolicy = { ownership, stages, crossCutting, roles };
export function selectSkills(catalog, role, explicit = [], { recovery = false } = {}) {
  if (!Object.hasOwn(roles, role)) throw new Error(`Invalid recovery/agent role: ${role}`);
  const reasons = new Map();
  for (const [reason, names] of [['cross-cutting', crossCutting], ['role', roles[role]], ['project', explicit], ['recovery', recovery ? ['debugging-and-error-recovery'] : []]]) {
    for (const name of names) reasons.set(name, [...(reasons.get(name) || []), reason]);
  }
  return [...reasons.keys()].sort().flatMap(name => {
    const matches = catalog.filter(item => item.name === name);
    if (matches.length > 1) throw new Error(`Skill is ambiguous: ${name}`);
    if (!matches.length) {
      if (explicit.includes(name) || catalog.some(item => item.layout === 'nested')) throw new Error(`Selected project/bundled skill is missing: ${name}`);
      return [];
    }
    if (matches[0].valid === false) throw new Error(`Selected skill is invalid: ${name}`);
    return [{ ...matches[0], workflowStep: matches[0].workflowStep ?? ownership[name] ?? null, selectionReason: reasons.get(name).join(', ') }];
  });
}
