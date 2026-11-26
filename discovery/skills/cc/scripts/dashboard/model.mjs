export const lanes = ['queued', 'intake', 'spec', 'plan', 'build', 'verify', 'review', 'approve', 'deliver', 'ready', 'done', 'failed', 'blocked'];
export const laneNames = { queued: 'Queued', intake: 'Intake', spec: 'Spec', plan: 'Plan', build: 'Build', verify: 'Verify', review: 'Review', approve: 'Approve', deliver: 'Deliver', ready: 'Ready for merge', done: 'Done', blocked: 'Blocked', failed: 'Failed' };

export function boardCards(repo, jobs, issues, prs) {
  const seen = new Set();
  const card = (job, issue) => {
    issue ||= job?.issue ? { number: job.issue.number, html_url: job.issue.url } : null;
    if (issue) seen.add(issue.number);
    const pr = prs.find(pr => pr.headRefName === job?.branch || pr.url === job?.pr?.url);
    const completed = pr?.state === 'MERGED' || issue?.state === 'closed';
    const deliveryConflict = !completed && job?.stage === 'ready' && pr && (pr.state === 'CLOSED' || pr.headRefOid !== job.commit);
    const labels = (issue?.labels || []).map(item => typeof item === 'string' ? item : item.name);
    const lane = completed ? 'done' : deliveryConflict || job?.legacy ? 'blocked' : job?.stage === 'blocked' && job.blocking === false ? 'failed' : job?.stage || (labels.includes('cc:failed') ? 'failed' : labels.includes('cc:rejected') ? 'rejected' : labels.includes('cc:blocked') || labels.includes('cc:running') ? 'blocked' : labels.includes('cc:ready') ? 'ready' : 'queued');
    return { key: `${repo}:${issue ? `issue-${issue.number}` : job.id}`, repo, title: issue?.title || job?.title || job?.request?.split('\n')[0] || job?.id,
      lane, updated: completed ? pr?.mergedAt || issue?.closed_at : job?.updated || issue?.updated_at,
      completedAt: completed ? pr?.mergedAt || issue?.closed_at : null, issue, job, pr,
      interruptedStage: job?.interruptedStage, blocker: deliveryConflict ? 'The PR was closed without merging or its head no longer matches the verified commit. Inspect GitHub before delivery.' : job?.blocker || (job?.legacy ? 'Legacy job: adoption is required before resuming.' : !job && lane === 'blocked' ? 'GitHub status has no local job record. Inspect the issue and original home before starting duplicate work.' : null) };
  };
  const result = jobs.map(job => card(job, issues.find(issue => issue.number === job.issue?.number)));
  for (const issue of issues) if (!seen.has(issue.number) && (issue.labels || []).some(item => (item.name || item).startsWith('cc:'))) result.push(card(null, issue));
  return result;
}
