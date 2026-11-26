import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safe, exists, json, atomic, transaction, alive } from './io.mjs';
import { positive } from './model.mjs';

export async function globalSettings(home) {
  const path = await safe(home, join(home, 'repos/factory.json'));
  const settings = await exists(path) ? await json(path) : { concurrency: 3 };
  if (Object.keys(settings).some(key => key !== 'concurrency')) throw new Error('Unknown home factory setting.');
  positive(settings.concurrency, 'Home concurrency');
  return settings;
}
export async function saveGlobalSettings(home, settings) {
  if (!settings || Object.keys(settings).some(key => key !== 'concurrency')) throw new Error('Only home concurrency can be configured.');
  positive(settings.concurrency, 'Home concurrency');
  const path = await safe(home, join(home, 'repos/factory.json'));
  return transaction(`${path}.lock`, async () => { await atomic(path, settings); return settings; });
}
export async function globalSlot(home, job, action) {
  const root = await safe(home, join(home, '.cc/factory/global'));
  const path = join(root, 'leases.json'), token = randomUUID();
  await transaction(join(root, 'admission.lock'), async () => {
    const leases = await exists(path) ? await json(path) : [];
    const { concurrency } = await globalSettings(home);
    if (leases.length >= concurrency) throw Object.assign(new Error('Home concurrency limit reached or stale slot requires recovery.'), { code: 'CC_CAPACITY' });
    leases.push({ token, repo: job.repo, job: job.id, pid: process.pid });
    await atomic(path, leases);
  });
  try { return await action(); }
  finally { await transaction(join(root, 'admission.lock'), async () => {
    await atomic(path, (await json(path)).filter(item => item.token !== token));
  }); }
}
export async function recoverGlobalSlot(home, repo, id) {
  const root = await safe(home, join(home, '.cc/factory/global'));
  const path = join(root, 'leases.json');
  await transaction(join(root, 'admission.lock'), async () => {
    const leases = await exists(path) ? await json(path) : [];
    if (leases.some(item => item.repo === repo && item.job === id && alive(item.pid))) throw new Error('Home lease owner is still live.');
    await atomic(path, leases.filter(item => item.repo !== repo || item.job !== id));
  });
}
export async function configurationWrite(home, action) {
  const root = await safe(home, join(home, '.cc/factory/global'));
  return transaction(join(root, 'admission.lock'), async () => {
    const path = join(root, 'leases.json');
    if (await exists(path) && (await json(path)).length) throw Object.assign(new Error('Home concurrency limit: configuration waits for running jobs to finish.'), { code: 'CC_CAPACITY' });
    return action();
  });
}
