import { posix } from 'node:path';
import { applicableInstructions } from './inspection.mjs';
import { failure } from './errors.mjs';

function projectAt(facts, cwd, ecosystem) {
  return facts.projects.filter(item => item.ecosystem === ecosystem && (item.path === '.' || item.path === cwd || cwd.startsWith(`${item.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function invalid(message) { throw failure('CHECK_INVALID', message); }

export function validateSkills(names, catalog) {
  for (const name of names) {
    const matches = catalog.skills.filter(skill => skill.name === name);
    if (matches.length !== 1 || !matches[0].valid) throw failure('SKILL_INVALID', `Skill ${name} does not resolve to one valid canonical home entry.`, { paths: matches.map(skill => skill.path) });
  }
  return names.map(name => catalog.skills.find(skill => skill.name === name));
}

function validateManager(project, selected) {
  if (project.manager.status === 'conflicting') invalid(`Package-manager evidence conflicts for ${project.path}.`);
  if (project.manager.name && project.manager.name !== selected) invalid(`Selected manager ${selected} contradicts ${project.manager.name} for ${project.path}.`);
  return project.manager.name ? [] : ['Package-manager selection has no confirmed declaration or lockfile evidence.'];
}

export function validateChecks(checks, facts, scopes) {
  return checks.map(check => {
    const cwd = posix.normalize(check.workingDirectory.replaceAll('\\', '/'));
    const result = { command: check.command, workingDirectory: check.workingDirectory, source: check.source,
      applicableInstructions: applicableInstructions(scopes, cwd).map(item => item.path), validationStatus: 'unresolved_structure', limits: [], evidence: [] };
    if (/\r|\n|\0/.test(check.command)) invalid('Check command must be a single line.');
    if (/[;&|<>`$]|\$\(/.test(check.command)) {
      result.limits.push('Custom or compound command requires project-specific interpretation.');
      return result;
    }
    // Recognize a deliberately small command grammar. Shell expansion remains opaque.
    const tokens = check.command.trim().split(/\s+/);
    const runner = tokens[0];
    for (let index = 1; index < tokens.length; index++) {
      const match = /^(--prefix|--cwd|--dir|-C|--manifest-path)(?:=(.*))?$/.exec(tokens[index]);
      if (match) {
        const target = match[2] ?? tokens[index + 1];
        if (!target) invalid('Check path override is missing its target.');
        const path = posix.normalize(posix.join(cwd, target.replaceAll('\\', '/')));
        if (posix.isAbsolute(target) || /^[a-z]:/i.test(target) || path === '..' || path.startsWith('../')) invalid('Check target escapes the checkout.');
      }
    }
    const node = projectAt(facts, cwd, 'node');
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(runner)) {
      if (node) result.limits.push(...validateManager(node, runner));
      let script;
      let argsStart;
      if (tokens[1] === 'run' || runner === 'npm' && tokens[1] === 'run-script') { script = tokens[2]; argsStart = 3; }
      else if (['test', 'start', 'stop', 'restart'].includes(tokens[1]) && runner !== 'bun') { script = tokens[1]; argsStart = 2; }
      if (!script || !/^[a-z0-9:._-]+$/i.test(script) || tokens.length > argsStart && tokens[argsStart] !== '--') {
        result.limits.push('Package-manager command is outside the supported script-invocation grammar.'); return result;
      }
      if (!node || node.path !== cwd) invalid('Package script must run from the directory containing its package.json.');
      if (!Object.hasOwn(node.scripts, script)) invalid(`Package script ${script} does not exist in ${node.manifest}.`);
      result.evidence.push(node.scripts[script].evidence, ...node.manager.evidence);
    } else if (runner === 'go' && tokens[1] === 'test') {
      const project = projectAt(facts, cwd, 'go');
      if (!project) invalid('go test requires a discovered Go module or workspace.');
      if (tokens.slice(2).some(token => !['.', './...', '-race', '-v', '-cover', '-short'].includes(token) && !/^-count=\d+$/.test(token))) {
        result.limits.push('Go flags or targets require project-specific interpretation.'); return result;
      }
      result.evidence.push(project.evidence.path);
    } else if (runner === 'cargo' && ['test', 'check', 'clippy', 'fmt'].includes(tokens[1])) {
      const project = projectAt(facts, cwd, 'rust');
      if (!project) invalid('Cargo checks require a discovered Cargo project or workspace.');
      const workspace = facts.projects.filter(item => item.ecosystem === 'rust' && item.workspace?.status === 'resolved' && item.workspace.members.includes(project.path)).sort((a, b) => b.path.length - a.path.length)[0] || project;
      for (let index = 2; index < tokens.length; index++) {
        if (tokens[index] !== '-p' && tokens[index] !== '--package') continue;
        const name = tokens[index + 1];
        if (!facts.projects.some(item => item.ecosystem === 'rust' && item.name === name && (item.path === workspace.path || workspace.workspace?.members.includes(item.path)))) invalid('Cargo package is outside the discovered workspace.');
      }
      if (tokens.some(token => /^--(?:manifest-path|config|target-dir)/.test(token))) {
        result.limits.push('Cargo path/config overrides require project-specific interpretation.'); return result;
      }
      const supported = new Set(['--workspace', '--all-targets', '--all-features', '--no-default-features', '--locked', '--offline', '--quiet', '--verbose', '-q', '-v']);
      const options = tokens.slice(2).filter((token, index, list) => token !== '-p' && token !== '--package' && list[index - 1] !== '-p' && list[index - 1] !== '--package');
      if (options.some(token => !supported.has(token))) {
        result.limits.push('Cargo flags or targets require project-specific interpretation.'); return result;
      }
      result.evidence.push(project.evidence.path, ...(workspace.workspace?.evidence || []));
    } else {
      let python = projectAt(facts, cwd, 'python');
      let script;
      if (['uv', 'poetry', 'pipenv'].includes(runner) && tokens[1] === 'run') script = tokens[2];
      if (python && script) {
        const candidates = facts.projects.filter(item => item.ecosystem === 'python' && item.path === python.path && Object.hasOwn(item.scripts, script));
        if (new Set(candidates.map(item => item.scripts[script].command)).size > 1) invalid('Python entry point has conflicting declarations.');
        python = candidates[0] || python;
        result.limits.push(...validateManager(python, runner));
      }
      if (python && script && Object.hasOwn(python.scripts, script) && tokens.length === 3) {
        result.evidence.push(python.scripts[script].evidence, ...python.manager.evidence);
      } else {
        result.limits.push('Custom command or external Python tool cannot be resolved from declared entry points.'); return result;
      }
    }
    result.validationStatus = result.limits.length ? 'unresolved_structure' : 'verified_structure';
    return result;
  });
}

export function checkGaps(checks) {
  return checks.filter(check => check.validationStatus !== 'verified_structure').map(check => `Check ${check.command} requires confirmation. ${check.limits.join(' ')}`);
}
