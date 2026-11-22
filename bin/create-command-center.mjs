#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { installHome } from '../installer/install.mjs';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { agent: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('Usage: create-command-center [directory] [--agent codex|claude|both]');
  } else {
    if (positionals.length > 1) throw new Error('Supply one destination directory.');
    let agent = values.agent;
    if (!agent && process.stdin.isTTY && process.stdout.isTTY) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        agent = (await prompt.question('Configure codex, claude, or both? [both] ')).trim() || 'both';
      } finally {
        prompt.close();
      }
    }
    if (!agent) throw new Error('Non-interactive installation requires --agent codex|claude|both.');
    const result = await installHome(positionals[0] || '.', agent);
    console.log(`Command Center installed in ${result.destination}`);
    console.log(`Configured agents: ${result.agents.join(', ')}`);
    console.log('Open a new agent session in this folder and invoke the cc skill.');
    console.log('Then ask: cc init https://github.com/owner/project');
  }
} catch (error) {
  console.error(`Command Center: ${error.message}`);
  process.exitCode = 1;
}
