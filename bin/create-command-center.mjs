#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { addAgent, installHome } from '../installer/install.mjs';
import { migrateSkills } from '../installer/migration.mjs';

const usage = `Usage: create-command-center [directory] [--agent codex|claude|grok|both|all]
       create-command-center [directory] --add-agent codex|claude|grok
       create-command-center [directory] --migrate-skills [--apply]`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      'add-agent': { type: 'string' },
      'migrate-skills': { type: 'boolean' },
      apply: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    if (positionals.length > 1) throw new Error('Supply one destination directory.');
    if (values['add-agent'] !== undefined && values.agent !== undefined) throw new Error('Do not combine --add-agent with --agent.');
    const directory = positionals[0] || '.';
    if (values.apply && !values['migrate-skills']) throw new Error('--apply requires --migrate-skills.');
    if (values['migrate-skills']) {
      if (values.agent !== undefined || values['add-agent'] !== undefined) throw new Error('Do not combine migration with installation/add-agent flags.');
      const result = await migrateSkills(directory, { apply: Boolean(values.apply) });
      console.log(JSON.stringify(result, null, 2));
      if (result.conflicts.length) process.exitCode = 1;
    } else {
    const adding = values['add-agent'] !== undefined;
    const result = adding ? await addAgent(directory, values['add-agent']) : await installHome(directory, await selectedAgent(values.agent));
    console.log(`Command Center ${adding ? 'updated' : 'installed'} in ${result.destination}`);
    console.log(`Configured agents: ${result.agents.join(', ')}`);
    console.log('Open a new agent session in this folder and invoke the cc skill.');
    console.log('Then ask: cc init https://github.com/owner/project');
    }
  }
} catch (error) {
  console.error(`Command Center: ${error.message}`);
  process.exitCode = 1;
}

async function selectedAgent(agent) {
  if (agent) return agent;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await prompt.question('Configure codex, claude, grok, both, or all? [both] ')).trim() || 'both';
    } finally {
      prompt.close();
    }
  }
  throw new Error('Non-interactive installation requires --agent codex|claude|grok|both|all.');
}
