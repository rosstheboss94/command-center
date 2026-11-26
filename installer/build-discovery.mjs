import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSkills, collectFiles } from './projection.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'discovery');
const expected = await projectSkills(root);
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Use --check or no flags.');
let current = new Map();
try { current = await collectFiles(output); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const differences = [...new Set([...expected.keys(), ...current.keys()])].filter(path => !expected.get(path)?.equals(current.get(path) || Buffer.alloc(0)));
if (check && differences.length) throw new Error(`Discovery projection drift; run node installer/build-discovery.mjs:\n${differences.join('\n')}`);
if (!check) {
  const extra = [...current.keys()].filter(path => !expected.has(path));
  if (extra.length) throw new Error(`Unexpected generated files; inspect before removing: ${extra.join(', ')}`);
  for (const [path, bytes] of expected) {
    const absolute = join(output, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
}
console.error(`${check ? 'Verified' : 'Generated'} ${expected.size} discovery files.`);
