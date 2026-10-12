#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installSkills } from './install_skills.mjs';

const adapters = { codex: 'codex_bridge.mjs', claude: 'claude_code_bridge.mjs', antigravity: 'antigravity_bridge.mjs' };
export function runAdapter(app, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(adapters[app], import.meta.url)), ...args],
      { windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '', error = '';
    if (capture) { child.stdout.setEncoding('utf8').on('data', s => { output += s; }); child.stderr.setEncoding('utf8').on('data', s => { error += s; }); }
    child.on('error', reject);
    child.on('close', code => {
      if (!capture) { resolve({ code }); return; }
      try { resolve({ code, result: JSON.parse(output) }); }
      catch { resolve({ code, result: { ok: false, error: error || output || `${app} returned no status` } }); }
    });
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Triangle Bridge — Codex, Claude Desktop Code, Antigravity\n\ntriangle-bridge status [--cwd PATH]\ntriangle-bridge install-skills\ntriangle-bridge codex <command> [options]\ntriangle-bridge claude code <command> [options]\ntriangle-bridge antigravity <command> [options]\n\nPass --help after an app name for its commands. Requires Node.js 22+ and running desktop apps on Windows.');
    return;
  }
  if (command === 'install-skills') { console.log(JSON.stringify(installSkills(), null, 2)); return; }
  if (command === 'status') {
    const results = await Promise.all(Object.keys(adapters).map(async app => {
      const commands = app === 'claude' ? ['code', 'list', '--json'] : ['list'];
      const { result } = await runAdapter(app, [...commands, ...args], true);
      const sessions = result.sessions || [...(result.response?.pinnedThreads || []), ...(result.response?.threads || [])];
      return { app, ok: result.ok === true, ...(result.version ? { version: result.version } : {}),
        ...(result.error ? { error: result.error } : {}), sessions: sessions.map(s => ({ sessionId: s.sessionId || s.id,
          title: s.title, cwd: s.cwd, workspaceUris: s.workspaceUris, projectId: s.projectId,
          status: s.status, permissionMode: s.permissionMode, model: s.model })) };
    }));
    console.log(JSON.stringify({ ok: results.every(r => r.ok), apps: results }, null, 2));
    if (results.some(r => !r.ok)) process.exitCode = 1;
    return;
  }
  if (!adapters[command]) throw new Error(`Unknown app or command: ${command}`);
  process.exitCode = (await runAdapter(command, args)).code ?? 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
