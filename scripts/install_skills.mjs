#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const resources = [
  'claude_code_bridge.mjs', 'claude_live_stdin.ps1', 'claude_peer_transport.mjs', 'claude_peer_pipe.ps1',
  'claude_session_create.mjs', 'claude_visible_transport.mjs', 'codex_bridge.mjs', 'codex_app_pipe.mjs',
  'codex_desktop_settings.mjs', 'antigravity_bridge.mjs', 'desktop_rpc.mjs', 'desktop_lifecycle.mjs',
];

export function installSkills({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex') } = {}) {
  const destinations = [path.join(codexHome, 'skills', 'triangle-bridge'), path.join(home, '.claude', 'skills', 'triangle-bridge'),
    path.join(home, '.gemini', 'config', 'skills', 'triangle-bridge')];
  const files = new Map([['SKILL.md', 'skills/triangle-bridge/SKILL.md'],
    ['agents/openai.yaml', 'skills/triangle-bridge/agents/openai.yaml'], ...resources.map(name => [`scripts/${name}`, `scripts/${name}`])]);
  for (const source of files.values()) if (!fs.statSync(path.join(root, source)).isFile()) throw new Error(`Missing package resource: ${source}`);
  for (const destination of destinations) for (const [relative, source] of files) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const incoming = fs.readFileSync(path.join(root, source));
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(incoming)) fs.writeFileSync(target, incoming);
  }
  return { ok: true, skill: 'triangle-bridge', destinations, resources: files.size };
}
