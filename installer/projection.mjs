import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { buildCatalog } from '../skills/ready/cc/scripts/inspection.mjs';

export async function collectFiles(root, prefix = '') {
  const info = await lstat(join(root, prefix));
  if (info.isSymbolicLink()) throw new Error(`Linked projection input: ${prefix}`);
  if (!info.isDirectory()) throw new Error(`Expected projection directory: ${prefix}`);
  const files = new Map();
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Linked projection input: ${path}`);
    if (entry.isDirectory()) for (const item of await collectFiles(root, path)) files.set(...item);
    else if (entry.isFile()) files.set(path, await readFile(join(root, path)));
    else throw new Error(`Unsupported projection input: ${path}`);
  }
  return files;
}

// Rewrite only references whose resolved targets are known projection inputs.
// Unrelated prose and external URLs retain their original bytes.
export function rewriteReferences(bytes, source, destination, mapping) {
  if (!/\.(?:md|mjs|js|sh|json|txt)$/.test(source)) return bytes;
  const text = bytes.toString('utf8');
  return Buffer.from(text.replace(/(?:\.\.\/|\.\/)+(?:[a-zA-Z0-9_.-]+\/?)+/g, value => {
    const target = posix.normalize(posix.join(posix.dirname(source), value));
    let mapped = mapping.get(target);
    if (!mapped) {
      for (const [from, to] of mapping) if (target.startsWith(`${from}/`)) { mapped = to + target.slice(from.length); break; }
    }
    if (!mapped) return value;
    const rewritten = posix.relative(posix.dirname(destination), mapped) || '.';
    const result = value.startsWith('./') && !rewritten.startsWith('.') ? `./${rewritten}` : rewritten;
    return value.endsWith('/') && !result.endsWith('/') ? `${result}/` : result;
  }));
}

export async function projectSkills(root) {
  const catalog = await buildCatalog(root);
  if (catalog.diagnostics.length) throw new Error(`Cannot project malformed/ambiguous skills: ${JSON.stringify(catalog.diagnostics)}`);
  const inputs = new Map(), mapping = new Map([['references', 'references']]);
  for (const skill of catalog.skills) {
    const source = posix.dirname(skill.path), destination = `skills/${skill.name}`;
    mapping.set(source, destination);
    for (const [path, bytes] of await collectFiles(root, source)) { inputs.set(path, bytes); mapping.set(path, destination + path.slice(source.length)); }
  }
  for (const [path, bytes] of await collectFiles(root, 'references')) { inputs.set(path, bytes); mapping.set(path, path); }
  const names = new Set();
  return new Map([...inputs].map(([source, bytes]) => {
    const destination = mapping.get(source);
    if (names.has(destination.toLowerCase())) throw new Error(`Case-conflicting discovery path: ${destination}`);
    names.add(destination.toLowerCase());
    return [destination, rewriteReferences(bytes, source, destination, mapping)];
  }).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
