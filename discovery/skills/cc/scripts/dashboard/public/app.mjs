const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name=cc-token]').content;
const params = new URLSearchParams(location.search);
let selected = params.get('repo') || 'all', view = params.get('view') || 'board', query = params.get('q') || '', stage = params.get('stage') || '';
let data, refreshing = false, settingsRepo = '', toastTimer, signature;
const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const button = (label, click, className = '') => { const element = node('button', className, label); element.type = 'button'; element.onclick = async () => { element.disabled = true; try { await click(); } catch (error) { toast(error.message); } finally { element.disabled = false; } }; return element; };
const age = value => { if (!value) return 'No recent activity'; const minutes = Math.max(0, Math.floor((Date.now() - new Date(value)) / 60000)); return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`; };
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
async function api(path, input) {
  const response = await fetch(`/api/${path}`, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CC-Token': token }, body: JSON.stringify(input) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
}
function saveLocation() { const url = new URL(location.href); url.search = ''; for (const [key, value] of Object.entries({ repo: selected, view, q: query, stage })) if (value) url.searchParams.set(key, value); history.replaceState(null, '', url); }
function modal(title, content, label = 'WORK DETAILS') { $('drawer-label').textContent = label; $('drawer-content').replaceChildren(node('h2', '', title)); $('drawer-content').firstChild.id = 'drawer-title'; $('drawer-content').append(content); if (!$('drawer').open) $('drawer').showModal(); }
function link(label, url) { const element = node('a', '', label); try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return node('span', '', label); element.href = parsed.href; } catch { return node('span', '', label); } element.target = '_blank'; element.rel = 'noopener noreferrer'; return element; }
function field(label, input) { const wrapper = node('label', 'field', label); wrapper.append(input); return wrapper; }
function input(value = '', type = 'text', placeholder = '') { const element = node('input'); element.type = type; element.value = value; element.placeholder = placeholder; if (type === 'number') { element.min = '1'; element.step = '1'; } return element; }
function select(values, value) { const element = node('select'); for (const [id, label] of values) { const option = node('option', '', label); option.value = id; element.append(option); } element.value = value; return element; }
function section(title, content) { const element = node('section', 'detail-section'); element.append(node('h3', '', title), content); return element; }
async function action(input) { const result = await api('action', input); toast(`${result.operations.length ? `${result.operations.length} action${result.operations.length === 1 ? '' : 's'} queued` : 'No new queued issues to start'}${result.errors?.length ? ` · ${result.errors.map(item => `${repoName(item.repo)}: ${item.error}`).join('; ')}` : ''}`); await refresh(); return result; }
function repoName(id) { return data.repos.find(repo => repo.id === id)?.name || id || 'Workspace'; }
function renderNavigation() {
  const nav = $('repo-nav'); nav.replaceChildren();
  for (const repo of [{ id: 'all', name: 'All repositories' }, ...data.repos]) {
    const element = button('', () => { selected = repo.id; view = 'board'; saveLocation(); render(); document.body.classList.remove('nav-open'); }, `nav-item${selected === repo.id && view !== 'settings' ? ' active' : ''}`);
    element.title = repo.name; element.setAttribute('aria-current', selected === repo.id && view !== 'settings' ? 'page' : 'false');
    element.dataset.focus = `repo:${repo.id}`;
    element.append(node('span', 'nav-icon', repo.id === 'all' ? '▦' : repo.name.split('/').at(-1).slice(0, 1).toUpperCase()), node('span', '', repo.id === 'all' ? repo.name : repo.name.split('/').at(-1)), node('span', 'nav-count', data.cards.filter(card => (repo.id === 'all' || card.repo === repo.id) && !['done', 'rejected'].includes(card.lane)).length)); nav.append(element);
  }
  $('settings-nav').classList.toggle('active', view === 'settings');
}
function filteredCards() {
  return data.cards.filter(card => (selected === 'all' || card.repo === selected) && (!stage || card.lane === stage)
    && `${card.title} ${card.issue?.number || ''} ${repoName(card.repo)} ${card.blocker || ''}`.toLowerCase().includes(query.toLowerCase())
    && (view === 'history' ? ['done', 'rejected'].includes(card.lane) : card.lane !== 'rejected' && (card.lane !== 'done' || (card.completedAt && Date.now() - new Date(card.completedAt) < 30 * 86400000))))
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}
function renderCard(card) {
  const element = button('', () => details(card), 'card'); element.setAttribute('aria-label', `${card.title}, ${data.laneNames[card.lane] || card.lane}, ${repoName(card.repo)}`);
  element.dataset.focus = `card:${card.key}`;
  const top = node('div', 'card-top'); top.append(node('span', 'repo-pill', selected === 'all' ? repoName(card.repo).split('/').at(-1) : card.job ? 'FACTORY JOB' : 'GITHUB ISSUE'), node('span', '', card.issue ? `#${card.issue.number}` : card.job?.id?.slice(-8)));
  const tag = node('span', `tag${['blocked', 'failed'].includes(card.lane) ? ' blocked' : ''}`, ['blocked', 'failed'].includes(card.lane) ? `${data.laneNames[card.lane]} · ${card.interruptedStage || 'legacy'}` : card.job?.workflowWarnings?.length ? `${card.job.workflowWarnings.length} warning(s)` : card.pr ? `PR #${card.pr.number}` : data.laneNames[card.lane]);
  const footer = node('div', 'card-footer'); footer.append(node('span', '', age(card.updated)), node('span', '', card.job ? `${card.job.round || 0} round${card.job.round === 1 ? '' : 's'} · ↗` : 'Issue · ↗'));
  element.append(top, node('h3', '', card.title), tag, footer); return element;
}
function render() {
  renderNavigation(); const settings = view === 'settings';
  $('title').textContent = settings ? 'Settings' : selected === 'all' ? 'All repositories' : repoName(selected).split('/').at(-1);
  $('breadcrumb').textContent = `Workspace / ${settings ? 'Settings' : selected === 'all' ? 'All repositories' : repoName(selected)}`;
  $('eyebrow').textContent = settings ? 'YOUR WORKSPACE, YOUR RULES' : 'YOUR WORK, IN MOTION';
  $('subtitle').textContent = settings ? 'Repository setup and the way your factory runs.' : selected === 'all' ? 'One workspace. Every step from idea to pull request.' : repoName(selected);
  $('board-view').hidden = settings; $('settings-view').hidden = !settings; document.querySelector('.heading-actions').hidden = settings;
  $('board-tab').classList.toggle('active', view === 'board'); $('history-tab').classList.toggle('active', view === 'history');
  $('notices').replaceChildren();
  for (const source of data.sources.filter(source => source.error)) $('notices').append(node('p', 'notice', `${repoName(source.repo)}: ${source.error}${source.fetchedAt ? ` · Last synced ${age(source.fetchedAt)}` : ' · GitHub state has not synced yet.'}`));
  for (const task of data.operations.filter(task => ['failed', 'interrupted', 'launching'].includes(task.status))) {
    const notice = node('p', 'notice', `${repoName(task.input.repo)} · ${task.input.action}: ${task.error || 'Starting worker; waiting for its process record.'}`);
    if (task.job) notice.append(node('span', '', ` Job ${task.job}.`)); $('notices').append(notice);
    if (task.status === 'interrupted' && (task.job || task.input.job)) notice.append(button('Inspect and recover', async () => { await api('recover', { operation: task.id }); toast('Recorded processes reconciled; inspect the job’s recovery state.'); await refresh(); }));
  }
  for (const task of data.operations.filter(task => task.status === 'queued' && ['settings', 'register'].includes(task.input.action))) $('notices').append(node('p', 'notice', `${repoName(task.input.repo)}: ${task.input.action === 'settings' ? 'Settings' : 'Registration'} will apply when running jobs finish.`));
  $('capacity').textContent = `${data.operations.filter(task => task.status === 'running').length} dashboard workers · ${data.settings.concurrency} shared job slots`;
  $('connection').textContent = 'Connected locally'; $('footer-status').textContent = `${data.host.toUpperCase()} · Local state updates every 2s · GitHub every 30s`;
  if (settings) return;
  const cards = filteredCards(); $('card-count').textContent = `${cards.length} work item${cards.length === 1 ? '' : 's'} · ${selected === 'all' ? `${data.repos.length} repositories` : '1 repository'}`;
  const board = $('board'); board.replaceChildren();
  if (!data.repos.length) { const empty = node('div', 'empty-lane', 'Your workspace starts with a repository.'); empty.append(button('Register repository', () => openSettings())); board.append(empty); return; }
  if (view === 'history') { const list = node('div', 'history-list'); for (const card of cards) list.append(renderCard(card)); if (!cards.length) list.append(node('p', 'empty-lane', 'No completed or rejected work matches these filters.')); board.append(list); return; }
  for (const lane of data.lanes.filter(lane => !stage || stage === lane)) {
    const column = node('section', 'lane'); column.dataset.stage = lane;
    const matches = cards.filter(card => card.lane === lane), heading = node('h2', 'lane-heading', data.laneNames[lane]); heading.append(node('span', 'count', matches.length)); column.append(heading);
    for (const card of matches) column.append(renderCard(card));
    if (!matches.length) column.append(node('div', 'empty-lane', lane === 'queued' ? 'Ideas ready for their next step' : 'No work here yet'));
    board.append(column);
  }
}
async function details(card) {
  if (card.job && !card.job.legacy) {
    try { card = { ...card, job: { ...card.job, ...await api(`job?repo=${encodeURIComponent(card.repo)}&job=${encodeURIComponent(card.job.id)}`) } }; }
    catch (error) { toast(`Could not refresh job state: ${error.message}`); }
  }
  const content = node('div'), meta = node('div', 'detail-meta');
  meta.append(node('span', 'tag', repoName(card.repo)), node('span', 'tag', data.laneNames[card.lane] || card.lane));
  if (card.issue) meta.append(link(`Issue #${card.issue.number} ↗`, card.issue.html_url)); if (card.pr || card.job?.pr) meta.append(link('Pull request ↗', card.pr?.url || card.job.pr.url)); content.append(meta);
  if (card.blocker) content.append(section(card.lane === 'done' ? 'Original factory record' : card.lane === 'failed' ? 'Execution failure or previous stop' : 'Blocker', node('p', 'error-text', card.blocker)));
  for (const warning of card.job?.warnings || []) content.append(node('p', 'notice', warning));
  if (card.job?.blocking === false) content.append(node('p', '', 'Workflow gates are off. Recorded failures and warnings do not imply checks passed.'));
  if (card.job?.workflowWarnings?.length) {
    const warnings = node('ul'); for (const warning of card.job.workflowWarnings) warnings.append(node('li', '', `${warning.stage}: ${warning.message}`));
    content.append(section('Workflow warnings', warnings));
  }
  const actions = node('div', 'detail-actions');
  const pending = data.operations.some(task => task.input.repo === card.repo && (task.input.job === card.job?.id || task.input.issue?.number === card.issue?.number) && ['queued', 'launching', 'running'].includes(task.status));
  if (!card.job && card.lane === 'queued') actions.append(button('▷ Start work', () => action({ action: 'start', repo: card.repo, issue: card.issue.number }), 'primary'));
  if (['blocked', 'failed'].includes(card.job?.stage) && card.lane !== 'done' && !card.job.legacy) {
    const exhausted = card.job.blocking === true && card.job.interruptedStage === 'build' && card.job.round >= (card.job.maxRounds || 3);
    if (exhausted) content.append(node('p', 'notice', 'Round limit reached. Start a successor job through chat or finish this work directly; this job cannot bypass its saved limit.'));
    else {
      if (!card.job.requiresFeedback || card.job.blocking === false) actions.append(button(card.job.stage === 'failed' ? 'Retry' : 'Resume', () => action({ action: 'resume', repo: card.repo, job: card.job.id }), 'primary'));
      actions.append(button('Give feedback', () => feedbackForm(card)));
    }
  }
  for (const element of actions.children) element.disabled = pending;
  content.append(actions); if (pending) content.append(node('p', '', 'An action for this card is already pending.'));
  content.append(section('Request', node('p', '', card.issue?.body || card.title)));
  if (card.job) {
    const checks = card.job.checks; if (checks) content.append(section('Checks', node('pre', 'evidence', JSON.stringify(checks, null, 2))));
    const timeline = node('ol', 'timeline'); for (const event of (card.job.history || []).slice(-30).reverse()) { const item = node('li'); item.append(node('strong', '', event.message || event.stage), node('span', '', event.at || '')); timeline.append(item); }
    content.append(section('Timeline', timeline));
    const evidence = node('div', 'detail-actions');
    for (const path of ['request.md', 'spec.md', 'plan.md', 'progress.md']) evidence.append(button(path.replace('.md', ''), async () => { const value = await api(`evidence?repo=${encodeURIComponent(card.repo)}&job=${encodeURIComponent(card.job.id)}&path=${path}`); modal(path, node('pre', 'evidence', `${value.text}${value.truncated ? '\n…truncated' : ''}`)); }));
    for (const attempt of (card.job.attempts || []).slice(-3)) for (const stream of ['stdout', 'stderr']) evidence.append(button(`${attempt.name} ${stream}`, async () => { const value = await api(`evidence?repo=${encodeURIComponent(card.repo)}&job=${encodeURIComponent(card.job.id)}&path=${encodeURIComponent(`attempts/${attempt.id}/${stream}.log`)}`); modal(`${attempt.name} ${stream}`, node('pre', 'evidence', value.text)); }));
    content.append(section('Saved evidence', evidence));
  }
  modal(card.title, content);
}
function feedbackForm(card) { const form = node('form'), text = node('textarea'); text.required = true; form.append(field('What should the job do next?', text), node('p', '', 'Your feedback is recorded exactly as entered. Existing checks and round limits still apply.')); const submit = node('button', 'primary', 'Save feedback and resume'); form.append(submit); form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; try { await action({ action: 'feedback', repo: card.repo, job: card.job.id, text: text.value }); $('drawer').close(); } catch (error) { toast(error.message); } finally { submit.disabled = false; } }; modal('Give feedback', form, 'RECOVERY'); }
function createIssue() {
  const form = node('form'), repo = select(data.repos.map(repo => [repo.id, repo.name]), selected === 'all' ? data.repos[0]?.id : selected), text = node('textarea'); text.required = true; text.rows = 7; text.placeholder = 'A short title on the first line, then describe the outcome you want.';
  form.append(field('Repository', repo), field('Idea', text), node('p', '', 'Creates a GitHub issue labeled cc:queued. Work starts only when you choose Start or Run queue.'));
  const submit = node('button', 'primary', 'Create issue'); form.append(submit); form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; try { await action({ action: 'add', repo: repo.value, text: text.value }); $('drawer').close(); } catch (error) { toast(error.message); } finally { submit.disabled = false; } }; modal('Create an issue', form, 'NEW WORK');
}
async function openSettings() {
  view = 'settings'; saveLocation(); render(); const root = $('settings-view'); root.replaceChildren();
  const global = node('section', 'settings-card'), limit = input(data.settings.concurrency, 'number'); global.append(node('h2', '', 'Shared capacity'), node('p', '', 'The job limit is shared across every repository, including work started in chat. Capacity changes affect new starts; running jobs finish normally.'), field('Concurrent jobs across this home', limit), button('Save capacity', async () => { const result = await api('settings', { concurrency: Number(limit.value) }); toast(result.pending ? 'Settings queued until running jobs finish' : 'Shared capacity saved'); await refresh(); }, 'primary')); root.append(global);
  const repoCard = node('section', 'settings-card'), repoSelect = select(data.repos.map(repo => [repo.id, repo.name]), settingsRepo || (selected !== 'all' ? selected : data.repos[0]?.id)), configRoot = node('div');
  repoCard.append(node('h2', '', 'Repository factory'), field('Repository', repoSelect), configRoot); root.append(repoCard);
  const load = async () => { settingsRepo = repoSelect.value; if (!settingsRepo) { configRoot.textContent = 'Register a repository to configure its factory.'; return; } configRoot.textContent = 'Loading settings…'; try { await repositorySettings(settingsRepo, configRoot); } catch (error) { configRoot.textContent = error.message; } }; repoSelect.onchange = load; await load();
  const registration = node('section', 'settings-card'); registration.append(node('h2', '', 'Register or refresh a repository'), node('p', '', 'Prepare a local checkout or clone a GitHub repository, inspect the detected project, and confirm its checks before registering. Existing job settings remain frozen.'));
  const source = input('', 'text', 'Local checkout path or https://github.com/owner/repo'); registration.append(field('Repository source', source), button('Prepare repository', async () => { const result = await api('prepare', { source: source.value }); registrationForm(result); })); root.append(registration);
}
async function repositorySettings(repo, root) {
  const current = await api(`settings?repo=${encodeURIComponent(repo)}`); root.replaceChildren();
  root.append(node('p', '', 'Assignments and checks apply to future jobs. Existing jobs keep their frozen configuration.'));
  if (current.conflict) root.append(node('p', 'notice', current.conflict));
  const effective = current.config || {}, numbers = {}, form = node('form');
  const blocking = input('', 'checkbox'); blocking.checked = current.settings.blocking === true;
  form.append(field('Enforce workflow blocking gates (off by default)', blocking), node('p', '', 'With gates off, checks and role verdicts are advisory. Failures stay in the evidence; Git/authentication/delivery errors still fail visibly.'));
  const row = node('div', 'form-row'); for (const [key, label, fallback] of [['concurrency', 'Repo job limit', 3], ['maxRounds', 'Maximum rounds', 3], ['checkTimeoutSeconds', 'Check timeout (seconds)', 1800]]) { numbers[key] = input(effective[key] || current.settings[key] || fallback, 'number'); row.append(field(label, numbers[key])); } form.append(row);
  const profiles = new Map();
  for (const role of ['default', 'intake', 'spec', 'plan', 'builder', 'review-code', 'review-security', 'review-ui', 'review-ux', 'approver']) {
    const saved = role === 'default' ? current.settings.default || {} : current.settings.roles?.[role] || {};
    const provider = select([['', role === 'default' ? `Invoking host (${data.host})` : 'Inherit default'], ['codex', 'Codex'], ['claude', 'Claude'], ['grok', 'Grok']], saved.runner || ''); provider.setAttribute('aria-label', `${role} provider`);
    const model = input(saved.model || '', 'text', role === 'default' ? 'CLI default model' : 'Inherit model'); model.setAttribute('aria-label', `${role} model`);
    const timeout = input(saved.timeoutSeconds || '', 'number', 'Inherit'); timeout.setAttribute('aria-label', `${role} timeout seconds`);
    provider.onchange = () => { model.value = ''; }; profiles.set(role, { provider, model, timeout, saved });
    const line = node('div', 'role-row'); line.append(node('span', '', role === 'default' ? 'Default runner' : role), provider, model, timeout); form.append(line);
  }
  const markdown = node('details'); markdown.append(node('summary', '', 'Review central Markdown configuration'), node('pre', 'evidence', current.markdown)); form.append(markdown);
  const reconcile = input('', 'checkbox'); if (current.conflict) form.append(field('I reviewed the Markdown and want to reconcile these factory settings', reconcile));
  const submit = node('button', 'primary', 'Save factory settings'); form.append(submit); form.onsubmit = async event => {
    event.preventDefault(); submit.disabled = true;
    try { const settings = { ...current.settings, blocking: blocking.checked, roles: {} }; for (const [key, element] of Object.entries(numbers)) settings[key] = Number(element.value);
      for (const [role, values] of profiles) {
        // Keep executable overrides unless the selected provider actually changes.
        const profile = {};
        if (values.provider.value) profile.runner = values.provider.value;
        if (values.model.value.trim()) profile.model = values.model.value.trim();
        if (values.timeout.value) profile.timeoutSeconds = Number(values.timeout.value);
        if (values.saved.executable && values.saved.runner === profile.runner) profile.executable = values.saved.executable;
        if (role === 'default') settings.default = profile;
        else if (Object.keys(profile).length) settings.roles[role] = profile;
      }
      const result = await api('settings', { repo, settings, markdownHash: current.markdownHash, reconcile: reconcile.checked }); toast(result.pending ? 'Settings queued until running jobs finish' : 'Factory settings saved'); await repositorySettings(repo, root);
    } catch (error) { toast(error.message); } finally { submit.disabled = false; }
  }; root.append(form);
  root.append(node('p', '', 'To change validated checks, use Register or refresh below with this repository’s checkout path.'));
}
function registrationForm({ token: preparedToken, report, previous = {} }) {
  const form = node('form'), purpose = input(previous.purpose || '', 'text', 'What is this repository for?'), checksRoot = node('div'), rows = [], baseBranch = input(previous.baseBranch || report.inspection.defaultBranch || '', 'text', report.inspection.currentBranch || 'main');
  form.append(node('p', '', `${report.id} · ${report.checkout}`), field('Purpose', purpose));
  form.append(field('Confirm base branch', baseBranch));
  const addCheck = (command = '', source = report.inspection.manifests[0] || '') => { const row = node('div', 'form-row'), commandInput = input(command, 'text', 'npm test'), directory = input('.', 'text', 'Working directory'), sourceInput = select([...new Set([...report.inspection.manifests, ...report.inspection.ci, ...report.inspection.documentation, ...report.inspection.instructions])].map(path => [path, path]), source); row.append(field('Check command', commandInput), field('Directory', directory), field('Evidence source', sourceInput), button('Remove', () => { rows.splice(rows.indexOf(value), 1); row.remove(); })); const value = { command: commandInput, workingDirectory: directory, source: sourceInput }; rows.push(value); checksRoot.append(row); };
  form.append(node('h3', '', 'Validated checks'), checksRoot, button('Add check', () => addCheck())); if (previous.checks?.length) for (const check of previous.checks) { addCheck(check.command, check.source); rows.at(-1).workingDirectory.value = check.workingDirectory; } else addCheck();
  const skills = input((previous.skills || []).join(', '), 'text', 'Optional comma-separated skill names'), gaps = node('textarea'); gaps.rows = 2; gaps.value = (previous.setupGaps || []).join('\n');
  form.append(field('Additional engineering skills', skills), field('Setup gaps (one per line; required if checks are incomplete)', gaps));
  const submit = node('button', 'primary', 'Confirm registration'); form.append(submit); form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; try {
    const details = { ...(purpose.value.trim() ? { purpose: purpose.value } : {}), ...(baseBranch.value.trim() ? { baseBranch: baseBranch.value.trim() } : {}), checks: rows.filter(row => row.command.value.trim()).map(row => Object.fromEntries(Object.entries(row).map(([key, input]) => [key, input.value]))), skills: skills.value.split(',').map(value => value.trim()).filter(Boolean), setupGaps: gaps.value.split('\n').map(value => value.trim()).filter(Boolean) };
    const result = await api('register', { token: preparedToken, details }); toast(result.pending ? 'Registration queued until running jobs finish' : 'Repository registered'); $('drawer').close(); await refresh(); await openSettings();
  } catch (error) { toast(error.message); } finally { submit.disabled = false; } }; modal('Review repository setup', form, 'REGISTRATION');
}
async function refresh(force = false) {
  if (refreshing) return; refreshing = true;
  try { const fresh = await api(`board${force ? '?refresh=1' : ''}`); const next = JSON.stringify(fresh); data = fresh; if (signature !== next) { signature = next; const focused = document.activeElement?.dataset.focus; render(); if (focused) document.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true }); } }
  catch (error) { $('connection').textContent = 'Connection interrupted'; $('footer-status').textContent = error.message; if (!data) $('board').replaceChildren(node('p', 'notice', error.message)); }
  finally { refreshing = false; }
}
$('search').value = query; $('search').oninput = event => { query = event.target.value; saveLocation(); if (data) render(); };
$('status-filter').onchange = event => { stage = event.target.value; saveLocation(); render(); };
$('board-tab').onclick = () => { view = 'board'; saveLocation(); render(); }; $('history-tab').onclick = () => { view = 'history'; saveLocation(); render(); };
$('refresh').onclick = () => refresh(true); $('menu').onclick = () => document.body.classList.toggle('nav-open'); $('close-drawer').onclick = () => $('drawer').close();
$('settings-nav').onclick = () => openSettings().catch(error => toast(error.message)); $('create-issue').onclick = () => { if (!data?.repos.length) return toast('Register a repository in Settings first.'); createIssue(); };
$('run-queue').onclick = async () => { $('run-queue').disabled = true; try { await action({ action: 'run', repo: selected }); } catch (error) { toast(error.message); } finally { $('run-queue').disabled = false; } };
await refresh();
if (data) { for (const lane of [...data.lanes, 'rejected']) { const option = node('option', '', data.laneNames[lane] || 'Rejected'); option.value = lane; $('status-filter').append(option); } $('status-filter').value = stage; if (view === 'settings') await openSettings(); }
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
