export const roles = ['intake', 'spec', 'plan', 'builder', 'review-code', 'review-security', 'review-ui', 'review-ux', 'approver'];
export const stages = ['intake', 'spec', 'plan', 'build', 'verify', 'review', 'approve', 'deliver', 'ready', 'blocked', 'rejected'];
const verdicts = { intake: ['ACCEPT', 'NEEDS_INFO', 'REJECT'], spec: ['READY', 'BLOCKED'], plan: ['READY', 'BLOCKED'], builder: ['READY', 'BLOCKED'], approver: ['APPROVE', 'BLOCKED', 'CHANGES'] };
export function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}
export function effectiveConfig(saved = {}, host) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid factory configuration.');
  for (const key of Object.keys(saved)) if (!['schemaVersion', 'default', 'roles', 'concurrency', 'maxRounds', 'checkTimeoutSeconds', 'requiredReviews'].includes(key)) throw new Error(`Unknown factory setting: ${key}`);
  if (saved.schemaVersion !== undefined && saved.schemaVersion !== 1) throw new Error('Unsupported factory config version.');
  const profile = (base, override = {}) => {
    for (const key of Object.keys(override)) if (!['runner', 'model', 'timeoutSeconds', 'executable'].includes(key)) throw new Error(`Unknown runner setting: ${key}`);
    const changed = override.runner && override.runner !== base.runner;
    const result = { ...base, ...(changed ? { model: null, executable: undefined } : {}), ...override };
    if (!['codex', 'claude', 'grok'].includes(result.runner)) throw new Error('Choose codex, claude, or grok as the runner.');
    if (result.model !== null && (typeof result.model !== 'string' || !result.model.trim() || /[\r\n\0]/.test(result.model))) throw new Error('Model must be null or a nonempty model ID.');
    positive(result.timeoutSeconds, 'timeoutSeconds');
    if (result.executable !== undefined && (typeof result.executable !== 'string' || !result.executable.trim() || /[\r\n\0]/.test(result.executable))) throw new Error('Invalid executable.');
    if (result.executable === undefined) delete result.executable;
    return result;
  };
  const defaults = profile({ runner: host, model: null, timeoutSeconds: 1800 }, saved.default);
  for (const role of Object.keys(saved.roles || {})) if (!roles.includes(role)) throw new Error(`Unknown role: ${role}`);
  const requiredReviews = [...new Set(['review-code', ...(saved.requiredReviews || [])])];
  if (requiredReviews.some(role => !roles.includes(role) || !role.startsWith('review-'))) throw new Error('Invalid required reviewer.');
  return { schemaVersion: 1, concurrency: positive(saved.concurrency ?? 3, 'concurrency'), maxRounds: positive(saved.maxRounds ?? 3, 'maxRounds'),
    checkTimeoutSeconds: positive(saved.checkTimeoutSeconds ?? 1800, 'checkTimeoutSeconds'), default: defaults,
    roles: Object.fromEntries(roles.map(role => [role, profile(defaults, saved.roles?.[role])])), requiredReviews };
}
export function validateReport(report, role, commit) {
  const allowed = verdicts[role] || ['PASS', 'CHANGES', 'BLOCKED'];
  if (!report || typeof report !== 'object' || !allowed.includes(report.verdict) || report.commit !== commit || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error(`Invalid ${role} verdict or stale commit.`);
  if (!Array.isArray(report.findings) || !report.findings.every(item => typeof item === 'string') || !Array.isArray(report.evidence) || !report.evidence.length || !report.evidence.every(item => typeof item === 'string' && item.trim())) throw new Error('Report requires findings and concrete evidence.');
  if (['PASS', 'APPROVE'].includes(report.verdict) && report.findings.length) throw new Error('Passing reports cannot contain unresolved findings.');
  if (report.requiredReviews && (!Array.isArray(report.requiredReviews) || report.requiredReviews.some(item => !['review-security', 'review-ui', 'review-ux'].includes(item)))) throw new Error('Invalid specialist review selection.');
  if (['spec', 'plan'].includes(role) && report.verdict === 'READY' && (typeof report.artifact !== 'string' || !report.artifact.trim())) throw new Error('Specification and plan require an artifact.');
  return report;
}
export function nextStage(stage, verdict) {
  const transitions = { intake: { ACCEPT: 'spec', NEEDS_INFO: 'blocked', REJECT: 'rejected' }, spec: { READY: 'plan', BLOCKED: 'blocked' },
    plan: { READY: 'build', BLOCKED: 'blocked' }, build: { READY: 'verify', BLOCKED: 'blocked' },
    review: { PASS: 'approve', CHANGES: 'build', BLOCKED: 'blocked' }, approve: { APPROVE: 'deliver', CHANGES: 'build', BLOCKED: 'blocked' } };
  const next = transitions[stage]?.[verdict];
  if (!next) throw new Error(`Invalid transition: ${stage}/${verdict}`);
  return next;
}
