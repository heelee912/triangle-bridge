import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('session discovery retains roaming and package profiles and adds Claude-Data', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-path-test-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const roaming = path.join(fixture, 'roaming');
  const local = path.join(fixture, 'local');
  const roots = [
    path.join(roaming, 'Claude'),
    path.join(local, 'Packages', 'Claude_example', 'LocalCache', 'Roaming', 'Claude'),
    path.join(local, 'Claude-Data', 'claude_example'),
  ];
  roots.forEach((root, index) => {
    const folder = path.join(root, 'claude-code-sessions', 'account', 'organization');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `local_test${index}.json`), JSON.stringify({
      sessionId: `local_test${index}`, cliSessionId: `cli${index}`, cwd: fixture,
    }));
    const waiting = path.join(folder, 'waiting-input');
    fs.mkdirSync(waiting);
    fs.writeFileSync(path.join(waiting, `local_test${index}.json`), JSON.stringify({ waiting: true }));
  });
  const script = fileURLToPath(new URL('./claude_code_bridge.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script, 'list', '--json'], {
    env: { ...process.env, APPDATA: roaming, LOCALAPPDATA: local }, encoding: 'utf8',
  });
  const sessions = JSON.parse(output).sessions.map((session) => session.sessionId).sort();
  assert.deepEqual(sessions, ['local_test0', 'local_test1', 'local_test2']);
});
