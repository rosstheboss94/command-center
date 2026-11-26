#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { command } from '../skills/ready/cc/scripts/factory.mjs';
try {
  const { values } = parseArgs({ options: { home: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log('Usage: command-center-dashboard --home <home> --host codex|claude|grok [--port 4310]');
  else await command('dashboard', values);
} catch (error) { console.error(error.message); process.exitCode = 1; }
