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
function jsonValueEnd(text, start) {
  const closer = text[start] === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return char === closer ? index + 1 : -1;
    }
  }
  return -1;
}

function reportObject(text) {
  const values = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{' && text[index] !== '[') continue;
    const end = jsonValueEnd(text, index);
    if (end < 0) continue;
    try {
      values.push(JSON.parse(text.slice(index, end)));
      index = end - 1;
    } catch {
      // A brace in surrounding prose is not a report.
    }
  }
  if (values.length !== 1 || !values[0] || typeof values[0] !== 'object' || Array.isArray(values[0])) {
    throw new Error('Provider report must contain one JSON object.');
  }
  return values[0];
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
  return reportObject(text);
}
