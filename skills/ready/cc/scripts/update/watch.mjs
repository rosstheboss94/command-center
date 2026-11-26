import { join } from 'node:path';
import { atomic, exists, json, now } from '../factory/io.mjs';
import { updateRoot, assertActive, updateStatus } from './state.mjs';
import { previewUpdate, prepareUpdate } from './prepare.mjs';

export function startUpdateWatcher(home, { interval = 60000, preview = previewUpdate, prepare = prepareUpdate } = {}) {
  let stopped = false, running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const path = join(await updateRoot(home), 'discovery.json');
    try {
      await assertActive(home);
      const available = await preview(home), prior = await exists(path) ? await json(path) : {};
      if (stopped) return;
      const status = await updateStatus(home);
      if (available.availableCommit === available.installedCommit || status.candidates.some(candidate => candidate.sourceHome === home && candidate.commit === available.availableCommit && candidate.status === 'ready')) return;
      if (prior.home === home && prior.commit === available.availableCommit && prior.attempted) return;
      await atomic(path, { home, commit: available.availableCommit, checked: now(), attempted: now(), status: 'preparing' });
      const candidate = await prepare(home, { ref: available.availableCommit });
      await atomic(path, { home, commit: available.availableCommit, checked: now(), candidate: candidate.id, attempted: now(), status: 'ready' });
    } catch (error) {
      const prior = await exists(path) ? await json(path) : {};
      await atomic(path, { ...prior, home, checked: now(), status: 'failed', error: error.message });
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, interval); timer.unref(); void tick();
  return { tick, close: () => { stopped = true; clearInterval(timer); } };
}
