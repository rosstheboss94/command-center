export function providerCommand(profile, role, prompt) {
  const readOnly = role !== 'builder';
  let args;
  if (profile.runner === 'codex') args = ['exec', '--json', '--sandbox', readOnly ? 'read-only' : 'workspace-write', '-c', 'features.multi_agent=false', '-'];
  else if (profile.runner === 'claude') args = ['-p', '--output-format', 'json', '--tools', readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash', '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  else if (profile.runner === 'grok') args = ['--single', '--output-format', 'json', '--no-subagents', '--permission-mode', 'default', '--sandbox', readOnly ? 'read-only' : 'workspace', '--deny', 'MCPTool', '--tools', readOnly ? 'read_file,list_dir,grep' : 'read_file,list_dir,grep,search_replace,write_file,run_terminal_cmd'];
  else throw new Error('Unsupported runner; no provider fallback is permitted.');
  if (profile.model) args.push('--model', profile.model);
  return { file: profile.executable || profile.runner, args, input: prompt };
}
export function providerReport(runner, stdout) {
  let text;
  if (runner === 'codex') {
    const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (!events.some(event => event.type === 'turn.completed') || events.some(event => ['error', 'turn.failed'].includes(event.type))) throw new Error('Codex turn did not complete successfully.');
    text = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item.text;
  } else if (runner === 'grok') {
    const envelope = JSON.parse(stdout);
    if (envelope.stopReason !== 'end_turn' || envelope.type === 'error') throw new Error('Grok response did not complete its turn.');
    text = envelope.text;
  } else {
    const envelope = JSON.parse(stdout);
    if (envelope.type !== 'result' || envelope.is_error === true || (envelope.subtype && envelope.subtype !== 'success')) throw new Error(`${runner} response is not a successful result.`);
    text = envelope.result;
  }
  if (typeof text !== 'string') throw new Error('Provider result has no final report.');
  return JSON.parse(text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, ''));
}
