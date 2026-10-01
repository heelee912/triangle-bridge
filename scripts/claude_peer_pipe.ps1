$ErrorActionPreference = 'Stop'
$pipe = $null
$writing = $false
try {
  $envelope = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
  $r = $envelope.runtime
  if ($r.socketPath -notmatch '^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$') { throw 'Invalid Claude inbox pipe path' }
  $recordPath = Join-Path $env:USERPROFILE ".claude\sessions\$($r.pid).json"
  $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($record.pid -ne $r.pid -or $record.sessionId -cne $r.sessionId -or $record.procStart -ne $r.procStart -or $record.messagingSocketPath -cne $r.socketPath -or $record.cwd -ine $r.cwd) { throw 'Claude runtime record changed before connection' }
  $process = [Diagnostics.Process]::GetProcessById([int]$r.pid)
  if ($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $r.procStart) { throw 'Claude PID was reused or the runtime record is stale' }

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClaudePeerPipeOwner {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
}
'@
  $pipeName = $r.socketPath.Substring('\\.\pipe\'.Length)
  $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut)
  $pipe.Connect(3000)
  [uint32]$serverPid = 0
  if (-not [ClaudePeerPipeOwner]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(), [ref]$serverPid)) { throw 'Cannot verify Claude inbox server PID' }
  if ($serverPid -ne [uint32]$r.pid) { throw 'Claude inbox server PID does not match the selected session' }
  if ($envelope.probe) {
    @{ok=$true;serverPid=$serverPid;sessionId=$r.sessionId;procStart=$r.procStart;probe=$true} | ConvertTo-Json -Compress
  } else {
    if ($envelope.frame.session_id -cne $r.sessionId) { throw 'Message session ID does not match the selected runtime' }
    if ($envelope.auth.type -ne 'auth' -or $envelope.auth.token -cnotmatch '^[0-9a-f]{32}$') { throw 'Invalid inbox authentication frame' }
    $authLine = ConvertTo-Json -InputObject $envelope.auth -Compress -Depth 8
    $messageLine = ConvertTo-Json -InputObject $envelope.frame -Compress -Depth 8
    $bytes = [Text.Encoding]::UTF8.GetBytes($authLine + "`n" + $messageLine + "`n")
    $writing = $true
    $pipe.Write($bytes,0,$bytes.Length)
    $pipe.Flush()
    @{ok=$true;serverPid=$serverPid;sessionId=$r.sessionId;messageId=$envelope.frame.uuid;bytes=$bytes.Length;delivery='written-unconfirmed'} | ConvertTo-Json -Compress
  }
} catch {
  @{ok=$false;error=$_.Exception.Message;delivery=$(if ($writing) {'unknown'} else {'not-sent'})} | ConvertTo-Json -Compress
} finally {
  if ($null -ne $pipe) { $pipe.Dispose() }
}
