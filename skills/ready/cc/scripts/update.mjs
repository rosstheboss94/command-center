#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverHome } from './home.mjs';
import { updateStatus, assertActive, activate, rollback } from './update/state.mjs';
import { prepareUpdate, previewUpdate } from './update/prepare.mjs';
import { switchDashboard } from './update/dashboard.mjs';

export async function updateCommand(home, action = 'preview', values = {}) {
  if (action === 'status') return updateStatus(home);
  if (action === 'preview') return previewUpdate(home);
  await assertActive(home);
  if (action === 'prepare') return prepareUpdate(home, { ref: values.ref, destination: values.destination });
  if (action === 'apply') return activate(home, values.candidate, { switchDashboard });
  if (action === 'rollback') return rollback(home, { switchDashboard });
  throw new Error('Use cc update [prepare [--ref <ref>]|status|apply <candidate-id>|rollback].');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['home', 'cwd', 'ref', 'destination'].map(key => [key, { type: 'string' }])) });
    if (positionals.length > (positionals[0] === 'apply' ? 2 : 1)) throw new Error('Unexpected update arguments.');
    const { home } = await discoverHome(values);
    console.log(JSON.stringify(await updateCommand(home, positionals[0], { ...values, candidate: positionals[1] }), null, 2));
  } catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
