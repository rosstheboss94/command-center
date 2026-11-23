import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { atomic, exists, safe, json, hash, transaction } from './io.mjs';

const assets = new URL('../../assets/release-baselines/', import.meta.url);
const packageName = 'create-command-center';
const versions = ['0.3.0', '0.4.0'];
const registry = 'https://registry.npmjs.org';
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const metadataURL = version => `${registry}/${packageName}/${version}`;
const archiveName = version => `${packageName}-${version}.tgz`;

function validatePin(pin) {
  if (pin.name !== packageName || !versions.includes(pin.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.dist?.integrity || '') || !Number.isSafeInteger(pin.dist.fileCount) || pin.dist.fileCount < 1 || pin.dist.tarball !== `${registry}/${packageName}/-/${archiveName(pin.version)}`) throw new Error('Unsupported or malformed trusted release metadata.');
}
function validateMetadata(metadata, pin) {
  if (metadata.name !== pin.name || metadata.version !== pin.version || metadata.dist?.integrity !== pin.dist.integrity || metadata.dist?.tarball !== pin.dist.tarball || metadata.dist?.fileCount !== pin.dist.fileCount) throw new Error('Registry/local metadata differs from the pinned published release.');
}
async function trustedReleases() {
  const pins = JSON.parse(await readFile(new URL('pins.json', assets), 'utf8'));
  if (pins.schemaVersion !== 1 || !Array.isArray(pins.releases) || pins.releases.length !== versions.length || pins.releases.some((item, index) => item.version !== versions[index])) throw new Error('Incomplete trusted release pins.');
  for (const pin of pins.releases) {
    validatePin(pin);
    if (!/^[a-f0-9]{64}$/.test(pin.inventorySha256 || '')) throw new Error(`Missing trusted ${pin.version} inventory digest.`);
  }
  return pins.releases;
}
function tarFiles(archive) {
  if (archive.length > 4 * 1024 * 1024) throw new Error('Release archive exceeds its compressed size limit.');
  const tar = gunzipSync(archive, { maxOutputLength: 16 * 1024 * 1024 });
  const files = new Map(), seen = new Set();
  const string = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
  const number = bytes => {
    const text = string(bytes).trim();
    if (!/^[0-7]+$/.test(text)) throw new Error('Invalid tar entry size or checksum.');
    const value = parseInt(text, 8);
    if (!Number.isSafeInteger(value)) throw new Error('Tar entry number exceeds its limit.');
    return value;
  };
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || tar.subarray(offset).some(byte => byte !== 0)) throw new Error('Invalid tar end marker.');
      ended = true; break;
    }
    const checksum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (number(header.subarray(148, 156)) !== checksum) throw new Error('Invalid tar entry checksum.');
    const prefix = string(header.subarray(345, 500));
    const path = `${prefix ? `${prefix}/` : ''}${string(header.subarray(0, 100))}`.replace(/\/$/, '');
    const components = path.split('/');
    if (components[0] !== 'package' || components.some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe tar entry path.');
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate tar entry path.');
    seen.add(key);
    const size = number(header.subarray(124, 136));
    const type = header[156] || 48;
    const end = offset + 512 + Math.ceil(size / 512) * 512;
    if (end > tar.length) throw new Error('Truncated tar entry.');
    if (type === 48 && components.length > 1) files.set(components.slice(1).join('/'), tar.subarray(offset + 512, offset + 512 + size));
    else if (type !== 53 || size !== 0) throw new Error('Unsupported tar entry type; links and extended entries are not accepted.');
    offset = end;
  }
  if (!ended) throw new Error('Truncated release archive.');
  return files;
}
export function inspectArchive(archive, pin) {
  validatePin(pin);
  if (`sha512-${digest(archive, 'sha512', 'base64')}` !== pin.dist.integrity) throw new Error(`Release ${pin.version} archive integrity mismatch.`);
  const files = tarFiles(archive);
  const pkg = JSON.parse(files.get('package.json')?.toString('utf8') || 'null');
  if (pkg?.name !== pin.name || pkg.version !== pin.version) throw new Error('Archive package identity/version mismatch.');
  if (files.size !== pin.dist.fileCount) throw new Error('Archive file count differs from trusted metadata.');
  for (const required of ['installer/template/AGENTS.md', 'installer/template/gitignore', 'skills/cc/SKILL.md', 'LICENSE', 'LICENSE.agent-skills', 'UPSTREAM.md']) if (!files.has(required)) throw new Error(`Incomplete release: missing ${required}.`);
  const info = bytes => ({ sha256: hash(bytes), size: bytes.length });
  const packageFiles = Object.fromEntries([...files.keys()].sort().map(path => [path, info(files.get(path))]));
  const managed = new Map();
  const agents = pin.version === '0.3.0' ? ['claude', 'codex'] : ['claude', 'codex', 'grok'];
  for (const [path, bytes] of files) {
    if (path.startsWith('installer/template/')) {
      const target = path.slice('installer/template/'.length);
      managed.set(target === 'gitignore' ? '.gitignore' : target, { ...info(bytes), source: path, group: 'template' });
    } else if (/^(?:skills|references)\//.test(path) || ['LICENSE', 'LICENSE.agent-skills', 'UPSTREAM.md'].includes(path)) {
      managed.set(path, { ...info(bytes), source: path, group: path.startsWith('skills/') ? 'skill' : path.startsWith('references/') ? 'reference' : 'license' });
      if (/^(?:skills|references)\//.test(path)) for (const agent of agents) managed.set(`${agent === 'codex' ? '.agents' : `.${agent}`}/${path}`, { ...info(bytes), source: path, group: 'discovery', agent });
    }
  }
  managed.set('CLAUDE.md', { ...info(Buffer.from('Read AGENTS.md for this home repo’s instructions.\n')), group: 'discovery', agent: 'claude', generated: true });
  const markers = {};
  for (let mask = 0; mask < 2 ** agents.length; mask++) {
    const selected = agents.filter((_, index) => mask & (1 << index));
    markers[selected.join(',') || 'none'] = info(Buffer.from(encoded({ kind: 'command-center-home', schemaVersion: 1, templateVersion: pin.version, agents: selected })));
  }
  return { schemaVersion: 1, package: { name: pin.name, version: pin.version, dist: { ...pin.dist } },
    metadataURL: metadataURL(pin.version), packageFiles, managedFiles: Object.fromEntries([...managed.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), markers };
}
export async function bundledReleaseInputs() {
  const result = [];
  for (const pin of await trustedReleases()) {
    const path = new URL(`${pin.version}.json`, assets);
    const bytes = await readFile(path);
    if (!/^[a-f0-9]{64}$/.test(pin.inventorySha256 || '') || hash(bytes) !== pin.inventorySha256) throw new Error(`Bundled ${pin.version} release inventory integrity mismatch.`);
    const inventory = JSON.parse(bytes);
    validateMetadata(inventory.package, pin);
    if (inventory.schemaVersion !== 1 || Object.keys(inventory.packageFiles).length !== pin.dist.fileCount) throw new Error(`Incomplete bundled ${pin.version} inventory.`);
    result.push({ name: pin.name, version: pin.version, integrity: pin.dist.integrity, metadataURL: metadataURL(pin.version), inventoryPath: fileURLToPath(path), inventorySha256: pin.inventorySha256 });
  }
  return result;
}
async function response(fetcher, url) {
  const result = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!result.ok) throw new Error(`Registry request failed (${result.status}).`);
  return result;
}
async function downloadBytes(response, limit) {
  if (Number(response.headers?.get('content-length') || 0) > limit) throw new Error('Registry response exceeds its size limit.');
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('Registry response exceeds its size limit.');
    return bytes;
  }
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Registry response exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function archiveFile(path) {
  const info = await exists(path);
  if (!info?.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Missing release archive or archive exceeds its size limit.');
  return readFile(path);
}
export async function prepareReleaseInputs(home, { from, offline = false, fetcher = fetch, trusted } = {}) {
  const pins = trusted || await trustedReleases();
  pins.forEach(validatePin);
  const root = await safe(home, join(home, '.cc/factory/release-inputs'));
  return transaction(`${root}.lock`, async () => {
    const verified = [];
    for (const pin of pins) {
      try {
        let archive, metadata = pin;
        if (from) {
          const localRoot = await realpath(resolve(from));
          archive = await archiveFile(await safe(localRoot, join(localRoot, archiveName(pin.version))));
          const localMetadata = join(localRoot, `${pin.version}.metadata.json`);
          if (await exists(localMetadata)) metadata = await json(await safe(localRoot, localMetadata));
        } else if (offline || await exists(join(root, pin.version, 'package.tgz'))) {
          archive = await archiveFile(await safe(home, join(root, pin.version, 'package.tgz')));
          metadata = await json(await safe(home, join(root, pin.version, 'metadata.json')));
        } else {
          const metadataResponse = await response(fetcher, metadataURL(pin.version));
          metadata = metadataResponse.body ? JSON.parse((await downloadBytes(metadataResponse, 2 * 1024 * 1024)).toString('utf8')) : await metadataResponse.json();
          validateMetadata(metadata, pin);
          const download = await response(fetcher, pin.dist.tarball);
          archive = await downloadBytes(download, 4 * 1024 * 1024);
        }
        validateMetadata(metadata, pin);
        const inventory = inspectArchive(archive, pin);
        if (pin.inventorySha256 && hash(encoded(inventory)) !== pin.inventorySha256) throw new Error('Derived inventory differs from the pinned published baseline.');
        verified.push({ pin, archive, inventory });
      } catch (error) { throw new Error(`Release ${pin.version} inputs unavailable: ${error.message} Run release-inputs on a host with registry access or provide --from with verified ${archiveName(pin.version)}.`, { cause: error }); }
    }
    for (const { pin, archive, inventory } of verified) {
      const directory = await safe(home, join(root, pin.version));
      await atomic(await safe(home, join(directory, 'package.tgz')), archive);
      await atomic(await safe(home, join(directory, 'metadata.json')), pin);
      await atomic(await safe(home, join(directory, 'inventory.json')), inventory);
      await atomic(await safe(home, join(directory, 'receipt.json')), { schemaVersion: 1, name: pin.name, version: pin.version, integrity: pin.dist.integrity, inventorySha256: hash(encoded(inventory)), metadataURL: metadataURL(pin.version) });
    }
    return verified.map(({ pin }) => ({ version: pin.version, directory: join(root, pin.version) }));
  });
}
export async function releaseInputs(home) {
  const result = await bundledReleaseInputs();
  const pins = await trustedReleases();
  for (const entry of result) {
    const directory = await safe(home, join(home, '.cc/factory/release-inputs', entry.version));
    if (!(await exists(join(directory, 'receipt.json')))) continue;
    const pin = pins.find(pin => pin.version === entry.version);
    const receipt = await json(await safe(home, join(directory, 'receipt.json')));
    validateMetadata(await json(await safe(home, join(directory, 'metadata.json'))), pin);
    const inventory = inspectArchive(await archiveFile(await safe(home, join(directory, 'package.tgz'))), pin);
    if (receipt.schemaVersion !== 1 || receipt.name !== pin.name || receipt.version !== pin.version || receipt.integrity !== pin.dist.integrity || receipt.metadataURL !== metadataURL(pin.version) || receipt.inventorySha256 !== hash(encoded(inventory)) || hash(await readFile(await safe(home, join(directory, 'inventory.json')))) !== pin.inventorySha256) throw new Error(`Cached ${entry.version} receipt/inventory changed; rerun release-inputs with verified inputs.`);
    entry.archivePath = join(directory, 'package.tgz'); entry.cachedInventoryPath = join(directory, 'inventory.json');
  }
  return result;
}
