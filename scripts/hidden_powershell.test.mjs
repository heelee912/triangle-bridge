import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHiddenPowerShell } from './hidden_powershell.mjs';

test('hidden PowerShell preserves named parameters, switches, stdin and Unicode output', { skip: process.platform !== 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triangle-hidden-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.ps1');
  fs.writeFileSync(file, 'param([int]$ParentPid,[switch]$Enabled)\n$inputText=[Console]::In.ReadToEnd()\n[Console]::Write("$ParentPid|$Enabled|$inputText")', 'utf8');
  const output = runHiddenPowerShell(['-File', file, '-ParentPid', '123', '-Enabled'], { input: 'sample-input', encoding: 'utf8' });
  assert.equal(output, '123|True|sample-input');
  assert.equal(runHiddenPowerShell(['-Command', '[Console]::Write([char]0xD55C)'], { encoding: 'utf8' }), '한');
});

test('hidden PowerShell reports script failures', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => runHiddenPowerShell(['-Command', 'throw "failure-marker"'], { encoding: 'utf8' }), /Hidden PowerShell failed/);
});
