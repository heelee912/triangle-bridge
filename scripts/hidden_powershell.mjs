import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// wscript starts cmd and PowerShell with window style 0. Data travels through
// private temporary files so stdin and the exit status remain available.
export function runHiddenPowerShell(args, options = {}) {
  if (process.platform !== 'win32') throw new Error('Hidden PowerShell requires Windows');
  const fileIndex = args.indexOf('-File');
  const commandIndex = args.indexOf('-Command');
  if ((fileIndex >= 0) === (commandIndex >= 0)) throw new Error('Expected exactly one PowerShell -File or -Command');
  const namedArgs = {};
  if (fileIndex >= 0) {
    for (let i = fileIndex + 2; i < args.length; i++) {
      if (!/^-[A-Za-z][A-Za-z0-9]*$/.test(args[i])) throw new Error('PowerShell script arguments must use named parameters');
      const name = args[i].slice(1);
      namedArgs[name] = i + 1 < args.length && !String(args[i + 1]).startsWith('-') ? args[++i] : true;
    }
  }
  const payload = fileIndex >= 0 ? { file: args[fileIndex + 1], args: namedArgs } : { command: args[commandIndex + 1] };
  const script = `$p=(Get-Content -LiteralPath $env:TRIANGLE_HIDDEN_PAYLOAD -Raw -Encoding UTF8 | ConvertFrom-Json); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); if($p.file){ $scriptArgs=@{}; $p.args.psobject.Properties | ForEach-Object { $scriptArgs[$_.Name]=$_.Value }; & $p.file @scriptArgs } else { & ([scriptblock]::Create($p.command)) }; if(-not $?){exit 1}; if($LASTEXITCODE){exit $LASTEXITCODE}`;
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triangle-hidden-'));
  const input = path.join(dir, 'input'), output = path.join(dir, 'output'), errorFile = path.join(dir, 'error'), launcher = path.join(dir, 'launch.vbs');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const wscript = path.join(systemRoot, 'System32', 'wscript.exe');
  fs.writeFileSync(input, options.input || '');
  fs.writeFileSync(path.join(dir, 'payload.json'), JSON.stringify(payload), 'utf8');
  fs.writeFileSync(launcher, `Set sh = CreateObject("WScript.Shell")\r\nSet fso = CreateObject("Scripting.FileSystemObject")\r\nq = Chr(34)\r\nd = fso.GetParentFolderName(WScript.ScriptFullName)\r\nsys = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\\System32"\r\ncommand = q & sys & "\\cmd.exe" & q & " /d /s /c " & q & q & sys & "\\WindowsPowerShell\\v1.0\\powershell.exe" & q & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " & WScript.Arguments(0) & " < " & q & d & "\\input" & q & " > " & q & d & "\\output" & q & " 2> " & q & d & "\\error" & q & q\r\nexitCode = sh.Run(command, 0, True)\r\nWScript.Quit exitCode\r\n`);
  try {
    const result = spawnSync(wscript, ['//B', '//Nologo', launcher, encodedScript], { windowsHide: true, timeout: options.timeout || 15000, env: { ...(options.env || process.env), TRIANGLE_HIDDEN_PAYLOAD: path.join(dir, 'payload.json') } });
    if (result.error) throw result.error;
    const stdout = fs.existsSync(output) ? fs.readFileSync(output) : Buffer.alloc(0);
    const stderr = fs.existsSync(errorFile) ? fs.readFileSync(errorFile, 'utf8') : '';
    if (result.status !== 0) throw Object.assign(new Error(`Hidden PowerShell failed (exit ${result.status}): ${stderr.trim()}`), { status: result.status, stderr });
    if (options.maxBuffer && stdout.length > options.maxBuffer) throw new Error('Hidden PowerShell output exceeds maxBuffer');
    return options.encoding ? stdout.toString(options.encoding) : stdout;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
