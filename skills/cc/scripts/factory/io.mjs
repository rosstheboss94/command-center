import { mkdir, readFile, writeFile, rename, lstat, readdir, open, unlink, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value === '..') throw new Error('Invalid repository or job ID.');
  return value;
}
export async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
export async function safe(root, path) {
  root = await realpath(root); path = resolve(path);
  if (!inside(root, path)) throw new Error('Path escapes its owning directory.');
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await exists(current))?.isSymbolicLink()) throw new Error('Linked factory paths are not allowed.');
  }
  return path;
}
export async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  try { await rename(temp, path); } finally { await unlink(temp).catch(() => {}); }
}
export const json = async path => JSON.parse(await readFile(path, 'utf8'));
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
export async function lock(path, action) {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Factory lock exists: ${path}. Inspect owner/child processes before recovery.`); throw error; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, started: now() }));
  try { return await action(); } finally { await handle.close(); await unlink(path); }
}
export async function digestTree(root) {
  const items = [];
  async function walk(path, prefix = '') {
    const info = await exists(path);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error('Linked protected path.');
    if (info.isFile()) items.push([prefix, hash(await readFile(path))]);
    else if (info.isDirectory()) for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), `${prefix}/${entry}`);
  }
  await walk(root);
  return hash(JSON.stringify(items));
}

// No shell interpolation. Windows npm is a JS CLI behind a .cmd shim.
export async function execute(file, args, { cwd, input = '', timeoutSeconds = 1800, onStart = async () => {} } = {}) {
  if (process.platform === 'win32' && file === 'npm') {
    const candidate = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!(await exists(candidate))) throw new Error('Cannot locate npm-cli.js; use an explicit native executable for this check.');
    args = [candidate, ...args]; file = process.execPath;
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, oversized = false, bytes = 0;
    const stop = () => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSeconds * 1000);
    const collect = key => chunk => {
      bytes += chunk.length;
      if (bytes > 20 * 1024 * 1024) { oversized = true; stop(); return; }
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr, timedOut, oversized }); });
    child.on('spawn', async () => {
      try { await onStart(child.pid); child.stdin.end(input); }
      catch (error) { stop(); reject(error); }
    });
  });
}
export async function git(args, cwd, run = execute) {
  const result = await run('git', args, { cwd });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr?.trim() || 'unknown error'}`);
  return result.stdout.trim();
}
