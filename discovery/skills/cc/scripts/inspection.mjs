import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname, relative, resolve, isAbsolute, sep, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { parseToml, parseYaml, makeMatcher } from './vendor/parsers.mjs';
import { failure } from './errors.mjs';
import { ownership, stages, skillPolicy } from './skill-policy.mjs';

function inside(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

async function contents(root, path) {
  const absolute = resolve(root, path);
  if (!inside(root, absolute) || !inside(await realpath(root), await realpath(absolute)) || !(await lstat(await realpath(absolute))).isFile()) {
    throw failure('INSPECTION_INVALID', 'Inspection input must be a file inside its root.', { paths: [path] });
  }
  return readFile(absolute);
}

function evidence(path, field) { return { path, field }; }

function parseData(path, bytes) {
  const text = bytes.toString('utf8');
  if (/\.json$/.test(path) || posix.basename(path) === 'Pipfile.lock') return JSON.parse(text);
  if (/\.ya?ml$/.test(path)) return parseYaml(text, { maxAliasCount: 50, schema: 'core', logLevel: 'silent' });
  return parseToml(text);
}

export function instructionScopes(paths) {
  return paths.map(path => ({ path, scope: posix.dirname(path), kind: posix.dirname(path) === '.' ? 'root' : 'nested' }))
    .sort((a, b) => {
      const left = a.scope === '.' ? 0 : a.scope.split('/').length;
      const right = b.scope === '.' ? 0 : b.scope.split('/').length;
      return left - right || a.path.localeCompare(b.path, 'en');
    });
}

export function applicableInstructions(scopes, directory) {
  const path = directory.replaceAll('\\', '/').replace(/\/$/, '') || '.';
  return scopes.filter(item => item.scope === '.' || item.scope === path || path.startsWith(`${item.scope}/`));
}

export async function buildCatalog(home) {
  const root = join(home, 'skills');
  const skills = [];
  const diagnostics = [];
  const paths = [];
  const malformed = (path, message) => diagnostics.push({ code: 'SKILL_MALFORMED', path, message });
  async function walk(parts) {
    const directory = join(root, ...parts);
    const info = await lstat(directory);
    const path = ['skills', ...parts, 'SKILL.md'].join('/');
    if (info.isSymbolicLink()) { malformed(path, 'Linked skill/stage directory; replace it with a contained directory.'); return; }
    if (!info.isDirectory() || !inside(await realpath(home), await realpath(directory))) { malformed(path, 'Skill directory is outside the home.'); return; }
    let skillInfo;
    try { skillInfo = await lstat(join(directory, 'SKILL.md')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!skillInfo) {
      if (parts.length && !(parts.length === 1 && stages.includes(parts[0]))) malformed(path, 'SKILL.md is missing or ownership/depth is unsupported.');
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (entry.isDirectory() || entry.isSymbolicLink()) await walk([...parts, entry.name]);
      }
      return;
    }
    if (skillInfo.isSymbolicLink() || !skillInfo.isFile()) { malformed(path, 'Linked or non-file SKILL.md; use a contained regular file.'); return; }
    const bytes = await contents(home, path);
    paths.push(path);
    try {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes.toString('utf8'));
      if (!frontmatter) throw new Error('Missing frontmatter.');
      const value = parseYaml(frontmatter[1], { maxAliasCount: 50, schema: 'core', logLevel: 'silent' });
      if (typeof value?.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value.name) || typeof value.description !== 'string' || !value.description.trim()) throw new Error('Invalid name or description.');
      const layout = parts.length === 1 ? 'legacy-flat' : 'nested';
      const workflowStep = layout === 'legacy-flat' ? ownership[value.name] ?? null : parts[0];
      const valid = value.name === parts.at(-1) && (parts.length === 1 || (parts.length === 2 && stages.includes(workflowStep)))
        && (!ownership[value.name] || ownership[value.name] === workflowStep)
        && (value.workflowStep === undefined || value.workflowStep === workflowStep);
      skills.push({ name: value.name, description: value.description, workflowStep, layout, path, digest: createHash('sha256').update(bytes).digest('hex'), valid });
      if (!valid) malformed(path, 'Skill folder, depth or declared workflow ownership conflicts with the catalog policy.');
    } catch {
      diagnostics.push({ code: 'SKILL_MALFORMED', path, message: 'Invalid skill frontmatter.' });
    }
  }
  await walk([]);
  for (const name of new Set(skills.map(skill => skill.name))) {
    const matches = skills.filter(skill => skill.name === name);
    if (matches.length > 1) {
      matches.forEach(skill => { skill.valid = false; });
      diagnostics.push({ code: 'SKILL_AMBIGUOUS', name, message: 'Multiple home skills declare this name.' });
    }
  }
  for (const cc of skills.filter(skill => skill.name === 'cc' && skill.valid)) {
    const scriptDirectory = `${posix.dirname(cc.path)}/scripts`;
    const policyPath = `${scriptDirectory}/skill-policy.mjs`;
    try {
      if ((await lstat(join(home, scriptDirectory))).isSymbolicLink() || (await lstat(join(home, policyPath))).isSymbolicLink()) {
        cc.valid = false;
        malformed(policyPath, 'Linked policy input; restore the contained helper policy.');
      } else { await contents(home, policyPath); paths.push(policyPath); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Published legacy homes predate the ownership policy asset.
    }
  }
  return { skills, diagnostics, paths, policy: skillPolicy };
}

export async function snapshot(checkout, inspection, home, catalog) {
  const projectPaths = [...new Set(['instructions', 'manifests', 'lockfiles', 'ci', 'documentation'].flatMap(key => inspection[key]))].sort();
  const files = [];
  for (const [root, paths, kind] of [[checkout, projectPaths, 'project'], [home, catalog.paths, 'catalog']]) {
    for (const path of paths) files.push({ kind, path, digest: createHash('sha256').update(await contents(root, path)).digest('hex') });
  }
  return { files, catalogDiagnostics: catalog.diagnostics, catalogPolicy: catalog.policy };
}

export function compareSnapshots(previous, current) {
  const key = item => `${item.kind}:${item.path}`;
  const before = new Map(previous.files.map(item => [key(item), item.digest]));
  const after = new Map(current.files.map(item => [key(item), item.digest]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path));
  if (JSON.stringify(previous.catalogDiagnostics) !== JSON.stringify(current.catalogDiagnostics)) paths.push('catalog:skills/');
  if (JSON.stringify(previous.catalogPolicy) !== JSON.stringify(current.catalogPolicy)) paths.push('catalog:skill-policy');
  return [...new Set(paths)].sort();
}

function strings(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Workspace patterns must be an array of strings.');
  return value;
}

function workspace(patterns, excludes, source, field) {
  return { patterns: strings(patterns), excludes: strings(excludes), members: [], evidence: [evidence(source, field)], status: 'resolved' };
}

function declaredScripts(value, source, field, diagnostics) {
  const scripts = {};
  if (value === undefined) return scripts;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({ code: 'MANIFEST_INVALID', path: source, message: `${field} must be a mapping.` });
    return scripts;
  }
  for (const [name, command] of Object.entries(value)) {
    if (typeof command !== 'string') diagnostics.push({ code: 'MANIFEST_INVALID', path: source, message: `Unsupported script declaration in ${field}.` });
    else scripts[name] = { command, evidence: evidence(source, `${field}.${name}`) };
  }
  return scripts;
}

function project(ecosystem, manifest, data = {}) {
  return { ecosystem, path: posix.dirname(manifest), manifest, languages: [ecosystem === 'node' ? 'javascript' : ecosystem], scripts: {}, manager: { name: null, status: 'unknown', evidence: [] }, evidence: { path: evidence(manifest, 'file'), languages: evidence(manifest, 'file') }, ...data };
}

function manager(project, name, source, field) {
  project.manager = { name, status: 'resolved', evidence: [evidence(source, field)] };
}

function goValue(text, key) {
  const match = new RegExp(`^\\s*${key}\\s+("[^"\\r\\n]+"|[^\\s/][^\\s]*)`, 'm').exec(text);
  return match?.[1].replace(/^"|"$/g, '') || null;
}

function goUses(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*use\s+([^()]+?)\s*(?:\/\/.*)?$/.exec(line);
    if (match) values.push(match[1].trim().replace(/^"|"$/g, ''));
  }
  for (const block of text.matchAll(/^\s*use\s*\(([\s\S]*?)\)/gm)) {
    for (const line of block[1].split(/\r?\n/)) {
      const value = line.replace(/\/\/.*$/, '').trim().replace(/^"|"$/g, '');
      if (value) values.push(value);
    }
  }
  return values;
}

export async function collectFacts(checkout, inspection) {
  const projects = [];
  const diagnostics = [];
  const parsed = new Map();
  const allPaths = [...new Set([...inspection.manifests, ...inspection.lockfiles])].sort();
  for (const path of allPaths) {
    const leaf = posix.basename(path);
    const bytes = await contents(checkout, path);
    try {
      if (['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pyproject.toml', 'Pipfile', 'Pipfile.lock', 'uv.lock', 'poetry.lock', 'Cargo.toml', 'Cargo.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(leaf)) parsed.set(path, parseData(path, bytes));
      if (leaf === 'package.json') {
        const value = parsed.get(path);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
        const item = project('node', path, { name: typeof value.name === 'string' ? value.name : null });
        item.evidence.name = evidence(path, 'name');
        if (value.dependencies?.typescript || value.devDependencies?.typescript) {
          item.languages.push('typescript');
          item.evidence.typescript = evidence(path, value.dependencies?.typescript ? 'dependencies.typescript' : 'devDependencies.typescript');
        }
        item.scripts = declaredScripts(value.scripts, path, 'scripts', diagnostics);
        if (typeof value.engines?.node === 'string') { item.runtime = value.engines.node; item.evidence.runtime = evidence(path, 'engines.node'); }
        if (value.packageManager !== undefined) {
          if (typeof value.packageManager === 'string' && /^(npm|pnpm|yarn|bun)@\S+$/.test(value.packageManager)) manager(item, value.packageManager.split('@')[0], path, 'packageManager');
          else diagnostics.push({ code: 'MANAGER_UNKNOWN', path, message: 'Unsupported packageManager declaration.' });
        }
        if (value.workspaces !== undefined) {
          const patterns = Array.isArray(value.workspaces) ? value.workspaces : value.workspaces?.packages;
          if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string')) throw new Error('Invalid workspaces.');
          item.workspace = workspace(patterns, [], path, 'workspaces');
        }
        projects.push(item);
      } else if (leaf === 'pyproject.toml') {
        const value = parsed.get(path);
        const item = project('python', path, { name: value.project?.name || value.tool?.poetry?.name || null });
        item.evidence.name = evidence(path, value.project?.name ? 'project.name' : 'tool.poetry.name');
        item.runtime = value.project?.['requires-python'] || value.tool?.poetry?.dependencies?.python || null;
        item.evidence.runtime = evidence(path, value.project?.['requires-python'] ? 'project.requires-python' : 'tool.poetry.dependencies.python');
        if (value['build-system']) item.buildSystem = { backend: value['build-system']['build-backend'] || null, requires: strings(value['build-system'].requires), evidence: evidence(path, 'build-system') };
        item.scripts = declaredScripts(value.project?.scripts || value.tool?.poetry?.scripts, path, value.project?.scripts ? 'project.scripts' : 'tool.poetry.scripts', diagnostics);
        if (value.tool?.uv !== undefined) manager(item, 'uv', path, 'tool.uv');
        if (value.tool?.poetry !== undefined) {
          if (item.manager.name) diagnostics.push({ code: 'MANAGER_CONFLICT', path, message: 'Both uv and Poetry are declared.' });
          else manager(item, 'poetry', path, 'tool.poetry');
        }
        if (value.tool?.uv?.workspace) item.workspace = workspace(value.tool.uv.workspace.members, value.tool.uv.workspace.exclude, path, 'tool.uv.workspace');
        projects.push(item);
      } else if (leaf === 'Pipfile') {
        const item = project('python', path);
        manager(item, 'pipenv', path, 'file');
        item.scripts = declaredScripts(parsed.get(path).scripts, path, 'scripts', diagnostics);
        projects.push(item);
      } else if (leaf === 'requirements.txt') {
        if (!inspection.manifests.includes(posix.join(posix.dirname(path), 'pyproject.toml')) && !inspection.manifests.includes(posix.join(posix.dirname(path), 'Pipfile'))) {
          const item = project('python', path); manager(item, 'pip', path, 'file'); projects.push(item);
        }
      } else if (leaf === 'go.mod') {
        const text = bytes.toString('utf8');
        const item = project('go', path, { name: goValue(text, 'module'), runtime: goValue(text, 'go'), toolchain: goValue(text, 'toolchain') });
        if (!item.name) throw new Error('Missing module declaration.');
        item.evidence.name = evidence(path, 'module'); item.evidence.runtime = evidence(path, 'go'); item.evidence.toolchain = evidence(path, 'toolchain');
        manager(item, 'go', path, 'module'); projects.push(item);
      } else if (leaf === 'Cargo.toml') {
        const value = parsed.get(path);
        const item = project('rust', path, { name: value.package?.name || null, runtime: value.package?.['rust-version'] || null });
        item.evidence.name = evidence(path, 'package.name'); item.evidence.runtime = evidence(path, 'package.rust-version');
        manager(item, 'cargo', path, 'file');
        if (value.workspace) item.workspace = workspace(value.workspace.members, value.workspace.exclude, path, 'workspace');
        projects.push(item);
      } else if (leaf === 'go.work') {
        // Attach below, after all go.mod files have been read.
        parsed.set(path, goUses(bytes.toString('utf8')));
      } else if (inspection.manifests.includes(path) && leaf !== 'pnpm-workspace.yaml') {
        diagnostics.push({ code: 'UNSUPPORTED_MANIFEST', path, message: 'Detected manifest; structured parsing is unavailable.' });
      }
    } catch {
      diagnostics.push({ code: 'MANIFEST_INVALID', path, message: 'Manifest or lockfile could not be parsed with its documented data format.' });
      parsed.delete(path);
    }
  }

  for (const path of inspection.manifests.filter(path => posix.basename(path) === 'pnpm-workspace.yaml')) {
    const value = parsed.get(path);
    if (!value) continue;
    if (!Array.isArray(value.packages) || value.packages.some(pattern => typeof pattern !== 'string')) {
      diagnostics.push({ code: 'MANIFEST_INVALID', path, message: 'pnpm workspace packages must be an array of patterns.' });
      parsed.delete(path); continue;
    }
    if (!projects.some(item => item.ecosystem === 'node' && item.path === posix.dirname(path))) {
      const item = project('node', path);
      item.workspace = workspace(value.packages, [], path, 'packages');
      projects.push(item);
    }
  }
  for (const item of projects) {
    const directory = posix.dirname(item.manifest);
    const lockManagers = { node: { 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' }, python: { 'uv.lock': 'uv', 'poetry.lock': 'poetry', 'Pipfile.lock': 'pipenv' } };
    const evidenceItems = [...item.manager.evidence];
    const choices = new Set(item.manager.name ? [item.manager.name] : []);
    const workspacePath = posix.join(directory, 'pnpm-workspace.yaml');
    if (item.ecosystem === 'node' && parsed.has(workspacePath)) { choices.add('pnpm'); evidenceItems.push(evidence(workspacePath, 'file')); }
    item.lockfiles = [];
    const ecosystemLocks = { node: Object.keys(lockManagers.node), python: Object.keys(lockManagers.python), go: ['go.sum'], rust: ['Cargo.lock'] };
    for (const path of inspection.lockfiles.filter(path => posix.dirname(path) === directory && ecosystemLocks[item.ecosystem].includes(posix.basename(path)))) {
      const name = lockManagers[item.ecosystem]?.[posix.basename(path)];
      if (name) { choices.add(name); evidenceItems.push(evidence(path, 'file')); }
      const value = parsed.get(path);
      item.lockfiles.push({ path, version: value?.lockfileVersion ?? value?.version ?? value?._meta?.['pipfile-spec'] ?? null,
        parsing: parsed.has(path) ? 'parsed' : 'presence_only', evidence: evidence(path, 'file') });
    }
    if (choices.size > 1 || diagnostics.some(diagnostic => diagnostic.code === 'MANAGER_CONFLICT' && diagnostic.path === item.manifest)) {
      item.manager = { name: null, status: 'conflicting', evidence: evidenceItems };
      diagnostics.push({ code: 'MANAGER_CONFLICT', path: item.manifest, message: 'Package-manager evidence conflicts.' });
    } else if (choices.size === 1) item.manager = { name: [...choices][0], status: 'resolved', evidence: evidenceItems };
    if (item.ecosystem === 'node') {
      const declaration = parsed.get(workspacePath);
      if (declaration) {
        const patterns = strings(declaration.packages);
        if (item.workspace && JSON.stringify(item.workspace.patterns) !== JSON.stringify(patterns)) {
          item.workspace.status = 'conflicting';
          diagnostics.push({ code: 'WORKSPACE_CONFLICT', path: workspacePath, message: 'Workspace declarations disagree.' });
        } else item.workspace ||= workspace(patterns, [], workspacePath, 'packages');
      }
    }
  }
  for (const path of inspection.manifests.filter(path => posix.basename(path) === 'go.work')) {
    const members = parsed.get(path);
    if (!members) continue;
    const directory = posix.dirname(path);
    let item = projects.find(project => project.ecosystem === 'go' && project.path === directory);
    if (!item) { item = project('go', path); manager(item, 'go', path, 'use'); projects.push(item); }
    item.workspace = workspace(members, [], path, 'use');
  }
  for (const key of new Set(projects.map(item => `${item.ecosystem}:${item.path}`))) {
    const group = projects.filter(item => `${item.ecosystem}:${item.path}` === key);
    if (group.length < 2) continue;
    const names = new Set(group.map(item => item.manager.name).filter(Boolean));
    const evidenceItems = [...new Map(group.flatMap(item => item.manager.evidence).map(item => [JSON.stringify(item), item])).values()];
    if (names.size > 1 || group.some(item => item.manager.status === 'conflicting')) {
      for (const item of group) item.manager = { name: null, status: 'conflicting', evidence: evidenceItems };
      diagnostics.push({ code: 'MANAGER_CONFLICT', path: group[0].manifest, message: 'Project manifests in the same directory declare different managers.' });
    } else if (names.size === 1) {
      for (const item of group) item.manager = { name: [...names][0], status: 'resolved', evidence: evidenceItems };
    }
  }
  for (const item of projects.filter(project => project.workspace)) {
    const value = item.workspace;
    if (value.status === 'conflicting') continue;
    const include = value.patterns.filter(pattern => !pattern.startsWith('!'));
    const exclude = [...value.excludes, ...value.patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))];
    const absolutePattern = pattern => posix.normalize(posix.join(item.path, pattern.replaceAll('\\', '/')));
    if ([...include, ...exclude].some(pattern => isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || absolutePattern(pattern) === '..' || absolutePattern(pattern).startsWith('../'))) {
      value.status = 'unresolved'; diagnostics.push({ code: 'WORKSPACE_INVALID', path: item.manifest, message: 'Workspace pattern escapes the repository scope.' }); continue;
    }
    const candidates = projects.filter(candidate => candidate.ecosystem === item.ecosystem);
    for (const pattern of include) {
      const matcher = makeMatcher(absolutePattern(pattern), { dot: true });
      const matches = candidates.filter(candidate => matcher(candidate.path));
      if (!matches.length) diagnostics.push({ code: 'WORKSPACE_MEMBER_MISSING', path: item.manifest, message: `No discovered project matches workspace member ${pattern}.` });
      for (const candidate of matches) if (!exclude.some(pattern => makeMatcher(absolutePattern(pattern), { dot: true })(candidate.path))) value.members.push(candidate.path);
    }
    if (['rust', 'python'].includes(item.ecosystem) && item.name) value.members.push(item.path);
    value.members = [...new Set(value.members)].sort();
  }
  for (const item of projects.filter(project => project.manager.status === 'unknown')) {
    const parents = projects.filter(parent => parent !== item && parent.ecosystem === item.ecosystem && parent.workspace?.status === 'resolved' && parent.workspace.members.includes(item.path)).sort((a, b) => b.path.length - a.path.length);
    if (parents[0]) item.manager = { ...parents[0].manager, inheritedFrom: parents[0].path };
  }
  projects.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.ecosystem.localeCompare(b.ecosystem, 'en') || a.manifest.localeCompare(b.manifest, 'en'));
  return { projects, diagnostics: diagnostics.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.code.localeCompare(b.code, 'en')) };
}
