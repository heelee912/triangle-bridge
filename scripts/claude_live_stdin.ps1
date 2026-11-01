param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][int]$ChildPid,
  [Parameter(Mandatory = $true)][string]$ExpectedStart,
  [Parameter(Mandatory = $true)][string]$ExpectedSessionId,
  [string]$JsonLine,
  [string]$JsonLineBase64,
  [switch]$StdinBase64,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ($DryRun) {
  # A dry run only resolves the target pipe, so it must not wait for a payload on stdin.
  $JsonLine = ""
} elseif ($PSBoundParameters.ContainsKey("JsonLineBase64")) {
  $JsonLine = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($JsonLineBase64.Trim()))
} elseif ($StdinBase64) {
  $stdinText = [Console]::In.ReadToEnd()
  $JsonLine = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($stdinText.Trim()))
} elseif (-not $PSBoundParameters.ContainsKey("JsonLine")) {
  $JsonLine = [Console]::In.ReadToEnd()
  if ($JsonLine.EndsWith("`r`n")) {
    $JsonLine = $JsonLine.Substring(0, $JsonLine.Length - 2)
  } elseif ($JsonLine.EndsWith("`n")) {
    $JsonLine = $JsonLine.Substring(0, $JsonLine.Length - 1)
  }
}

if (-not $DryRun -and $JsonLine.Length -eq 0) {
  throw "JsonLine is empty; pass -JsonLine or pipe JSON to stdin."
}

$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;

public static class ClaudeLiveStdinWriter {
  [StructLayout(LayoutKind.Sequential)]
  struct SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX {
    public IntPtr Object;
    public UIntPtr UniqueProcessId;
    public UIntPtr HandleValue;
    public uint GrantedAccess;
    public ushort CreatorBackTraceIndex;
    public ushort ObjectTypeIndex;
    public uint HandleAttributes;
    public uint Reserved;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public IntPtr Information;
  }

  const int SystemExtendedHandleInformation = 64;
  const int ProcessBasicInformation = 0;
  const int ObjectNameInformation = 1;
  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  const uint PROCESS_VM_READ = 0x0010;
  const uint PROCESS_DUP_HANDLE = 0x0040;
  const uint DUPLICATE_SAME_ACCESS = 0x00000002;
  const uint FILE_TYPE_PIPE = 3;

  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int c, IntPtr b, int l, ref int r);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr p, int c, ref PROCESS_BASIC_INFORMATION i, int l, out int r);
  [DllImport("ntdll.dll")]
  static extern int NtQueryObject(IntPtr handle, int infoClass, IntPtr info, int infoLength, ref int returnLength);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationFile(IntPtr handle, out IO_STATUS_BLOCK status, IntPtr info, int length, int infoClass);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint desiredAccess, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetNamedPipeInfo(IntPtr pipe, out uint flags, IntPtr outBufferSize, IntPtr inBufferSize, IntPtr maxInstances);
  [DllImport("kernel32.dll", EntryPoint="GetNamedPipeInfo", SetLastError=true)]
  static extern bool GetPipeDetails(IntPtr pipe, out uint flags, out uint outSize, out uint inSize, out uint maxInstances);
  const uint PIPE_SERVER_END = 1;
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool WriteFile(IntPtr handle, byte[] buffer, uint bytesToWrite, out uint bytesWritten, IntPtr overlapped);

  static ulong ReadU64(IntPtr process, long address) {
    var bytes = new byte[8];
    IntPtr read;
    if (!ReadProcessMemory(process, new IntPtr(address), bytes, bytes.Length, out read)) {
      throw new Exception("ReadProcessMemory failed: " + Marshal.GetLastWin32Error());
    }
    return BitConverter.ToUInt64(bytes, 0);
  }

  static List<SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX> QueryHandles() {
    int length = 1 << 20;
    IntPtr buffer = IntPtr.Zero;
    while (true) {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      buffer = Marshal.AllocHGlobal(length);
      int returned = 0;
      int status = NtQuerySystemInformation(SystemExtendedHandleInformation, buffer, length, ref returned);
      if (status == unchecked((int)0xC0000004) || status == unchecked((int)0xC0000023)) {
        length = Math.Max(length * 2, returned + 65536);
        continue;
      }
      if (status < 0) throw new Exception("NtQuerySystemInformation failed: 0x" + status.ToString("X8"));
      break;
    }

    try {
      long count = Marshal.ReadIntPtr(buffer).ToInt64();
      int headerSize = IntPtr.Size * 2;
      int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
      var handles = new List<SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX>();
      for (long i = 0; i < count; i++) {
        IntPtr entry = IntPtr.Add(buffer, headerSize + (int)(i * entrySize));
        handles.Add((SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(entry, typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)));
      }
      return handles;
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  static string QueryName(IntPtr handle) {
    int length = 65536;
    IntPtr buffer = Marshal.AllocHGlobal(length);
    try {
      int returned = 0;
      int status = NtQueryObject(handle, ObjectNameInformation, buffer, length, ref returned);
      if (status < 0) return "NTERR 0x" + status.ToString("X8");
      var value = (UNICODE_STRING)Marshal.PtrToStructure(buffer, typeof(UNICODE_STRING));
      if (value.Length == 0 || value.Buffer == IntPtr.Zero) return "";
      return Marshal.PtrToStringUni(value.Buffer, value.Length / 2) ?? "";
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  static string QueryNameWithTimeout(IntPtr handle, int timeoutMs) {
    string text = "TIMEOUT";
    bool done = false;
    var thread = new Thread(() => {
      try {
        text = QueryName(handle);
      } catch (Exception ex) {
        text = "EX " + ex.GetType().Name + ":" + ex.Message;
      } finally {
        done = true;
      }
    });
    thread.IsBackground = true;
    thread.Start();
    thread.Join(timeoutMs);
    return done ? text : "TIMEOUT";
  }

  static Dictionary<string, ulong> ReadChildStandardHandles(int childPid) {
    IntPtr process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE, false, childPid);
    if (process == IntPtr.Zero) throw new Exception("OpenProcess child failed: " + Marshal.GetLastWin32Error());

    try {
      var info = new PROCESS_BASIC_INFORMATION();
      int returned;
      int status = NtQueryInformationProcess(process, ProcessBasicInformation, ref info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned);
      if (status < 0) throw new Exception("NtQueryInformationProcess failed: 0x" + status.ToString("X8"));
      ulong parameters = ReadU64(process, info.PebBaseAddress.ToInt64() + 0x20);
      var handles = new Dictionary<string, ulong>();
      handles["stdin"] = ReadU64(process, (long)parameters + 0x20);
      handles["stdout"] = ReadU64(process, (long)parameters + 0x28);
      handles["stderr"] = ReadU64(process, (long)parameters + 0x30);
      return handles;
    } finally {
      CloseHandle(process);
    }
  }

  static string QueryChildHandleName(int childPid, ulong handleValue) {
    IntPtr process = OpenProcess(PROCESS_DUP_HANDLE, false, childPid);
    if (process == IntPtr.Zero) throw new Exception("OpenProcess child duplicate failed: " + Marshal.GetLastWin32Error());

    try {
      IntPtr duplicate;
      if (!DuplicateHandle(process, new IntPtr(unchecked((long)handleValue)), GetCurrentProcess(), out duplicate, 0, false, DUPLICATE_SAME_ACCESS)) {
        throw new Exception("Duplicate child handle failed: " + Marshal.GetLastWin32Error());
      }
      try {
        return QueryNameWithTimeout(duplicate, 300);
      } finally {
        CloseHandle(duplicate);
      }
    } finally {
      CloseHandle(process);
    }
  }

  static uint QueryChildHandleFileType(int childPid, ulong handleValue) {
    IntPtr process = OpenProcess(PROCESS_DUP_HANDLE, false, childPid);
    if (process == IntPtr.Zero) throw new Exception("Cannot inspect child handle");
    try {
      IntPtr duplicate;
      if (!DuplicateHandle(process, new IntPtr(unchecked((long)handleValue)), GetCurrentProcess(), out duplicate, 0, false, DUPLICATE_SAME_ACCESS))
        throw new Exception("Cannot duplicate child standard handle");
      try { return GetFileType(duplicate); } finally { CloseHandle(duplicate); }
    } finally { CloseHandle(process); }
  }

  const string LibuvPipePrefix = "\\Device\\NamedPipe\\uv\\";

  static ulong ParseLibuvPipeIndex(int parentPid, string pipeName, string label) {
    string suffix = "-" + parentPid.ToString();
    if (pipeName == null ||
        !pipeName.StartsWith(LibuvPipePrefix, StringComparison.OrdinalIgnoreCase) ||
        !pipeName.EndsWith(suffix, StringComparison.Ordinal)) {
      throw new Exception("Child " + label + " is not a libuv pipe of Claude Desktop " + parentPid + ": " + pipeName);
    }
    string digits = pipeName.Substring(LibuvPipePrefix.Length, pipeName.Length - LibuvPipePrefix.Length - suffix.Length);
    ulong index;
    if (!UInt64.TryParse(digits, out index)) throw new Exception("Child " + label + " pipe index is not numeric: " + pipeName);
    return index;
  }

  public static string VerifiedStdinPipeName(int parentPid, string name) {
    ParseLibuvPipeIndex(parentPid, name, "stdin");
    return name;
  }

  public static int SelectStdinPipe(string expectedStdinName, string[] parentPipeNames) {
    int selected = -1;
    for (int i = 0; i < parentPipeNames.Length; i++) {
      if (!String.Equals(expectedStdinName, parentPipeNames[i], StringComparison.OrdinalIgnoreCase)) continue;
      if (selected >= 0) throw new Exception("Multiple parent pipes are named " + expectedStdinName + "; refusing to send.");
      selected = i;
    }
    if (selected < 0) throw new Exception("No writable parent server pipe is named " + expectedStdinName + "; refusing to send.");
    return selected;
  }

  static bool PipeUsedByProcess(IntPtr pipe, int processId) {
    bool used = false;
    Exception failure = null;
    var thread = new Thread(() => {
      const int size = 65536;
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        IO_STATUS_BLOCK status;
        int result = NtQueryInformationFile(pipe, out status, buffer, size, 47);
        if (result != 0) throw new Exception("Cannot verify pipe users: NTSTATUS 0x" + result.ToString("X8"));
        int count = Marshal.ReadInt32(buffer);
        int offset = IntPtr.Size;
        if (count < 0 || count > (size - offset) / IntPtr.Size) throw new Exception("Invalid pipe user list");
        for (int i = 0; i < count; i++)
          if (Marshal.ReadIntPtr(buffer, offset + i * IntPtr.Size).ToInt64() == processId) { used = true; break; }
      } catch (Exception ex) { failure = ex; }
      finally { Marshal.FreeHGlobal(buffer); }
    });
    thread.IsBackground = true;
    thread.Start();
    if (!thread.Join(300)) throw new Exception("Timed out verifying pipe users");
    if (failure != null) throw failure;
    return used;
  }

  static void VerifyProcessStart(int pid, string expectedStart) {
    using (var process = System.Diagnostics.Process.GetProcessById(pid)) {
      if (process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() != expectedStart)
        throw new Exception("Claude session process changed before the write");
    }
  }

  public static string Send(int parentPid, int childPid, string expectedStart, string jsonLine, bool dryRun) {
    bool writing = false;
    try {
    var standardHandles = ReadChildStandardHandles(childPid);
    if (QueryChildHandleFileType(childPid, standardHandles["stdin"]) != FILE_TYPE_PIPE)
      throw new Exception("Claude stdin is not a pipe");
    string stdoutName = QueryChildHandleName(childPid, standardHandles["stdout"]);
    string stderrName = QueryChildHandleName(childPid, standardHandles["stderr"]);
    VerifyProcessStart(childPid, expectedStart);
    ParseLibuvPipeIndex(parentPid, stdoutName, "stdout");
    ParseLibuvPipeIndex(parentPid, stderrName, "stderr");
    if (String.Equals(stdoutName, stderrName, StringComparison.OrdinalIgnoreCase)) throw new Exception("Claude stdout and stderr are not distinct");

    var handles = QueryHandles();
    IntPtr parent = OpenProcess(PROCESS_DUP_HANDLE, false, parentPid);
    if (parent == IntPtr.Zero) throw new Exception("OpenProcess parent failed: " + Marshal.GetLastWin32Error());

    var parentPipes = new List<IntPtr>();
    var parentPipeNames = new List<string>();
    var parentHandleValues = new List<ulong>();
    int stdoutCount = 0, stderrCount = 0;
    try {
      foreach (var entry in handles) {
        if (entry.UniqueProcessId.ToUInt64() != (ulong)parentPid) continue;
        if ((entry.GrantedAccess & 0x00000002) == 0) continue;
        ulong handleValue = entry.HandleValue.ToUInt64();
        IntPtr duplicate;
        if (!DuplicateHandle(parent, new IntPtr(unchecked((long)handleValue)), GetCurrentProcess(), out duplicate, 0, false, DUPLICATE_SAME_ACCESS)) {
          continue;
        }
        try {
          if (GetFileType(duplicate) != FILE_TYPE_PIPE) continue;
          uint pipeFlags, outSize, inSize, maxInstances;
          if (!GetPipeDetails(duplicate, out pipeFlags, out outSize, out inSize, out maxInstances) || (pipeFlags & PIPE_SERVER_END) == 0) continue;
          string name = QueryNameWithTimeout(duplicate, 150);
          if (name == "TIMEOUT") {
            if (PipeUsedByProcess(duplicate, childPid)) throw new Exception("Cannot name a pipe used by the target process");
            continue;
          }
          if (!name.StartsWith(LibuvPipePrefix, StringComparison.OrdinalIgnoreCase)) {
            if (PipeUsedByProcess(duplicate, childPid)) throw new Exception("The target uses an additional parent pipe; refusing ambiguous selection");
            continue;
          }
          ParseLibuvPipeIndex(parentPid, name, "parent");
          if (!PipeUsedByProcess(duplicate, childPid)) continue;
          if (maxInstances != 1) throw new Exception("Pipe name has multiple allowed instances; refusing to send");
          if (String.Equals(name, stdoutName, StringComparison.OrdinalIgnoreCase)) { stdoutCount++; continue; }
          if (String.Equals(name, stderrName, StringComparison.OrdinalIgnoreCase)) { stderrCount++; continue; }
          parentPipes.Add(duplicate);
          parentPipeNames.Add(name);
          parentHandleValues.Add(handleValue);
          duplicate = IntPtr.Zero;
        } finally {
          if (duplicate != IntPtr.Zero) CloseHandle(duplicate);
        }
      }
      if (stdoutCount != 1 || stderrCount != 1 || parentPipes.Count != 1)
        throw new Exception("Expected exactly the target process's stdout, stderr, and one input pipe; refusing to send");
      int selected = SelectStdinPipe(parentPipeNames[0], parentPipeNames.ToArray());
      string stdinName = VerifiedStdinPipeName(parentPid, parentPipeNames[selected]);
      VerifyProcessStart(childPid, expectedStart);
      var currentHandles = ReadChildStandardHandles(childPid);
      if (currentHandles["stdin"] != standardHandles["stdin"] || currentHandles["stdout"] != standardHandles["stdout"] || currentHandles["stderr"] != standardHandles["stderr"] || !PipeUsedByProcess(parentPipes[selected], childPid))
        throw new Exception("Claude standard handles or pipe users changed before the write");
      if (dryRun) {
        return "{\"ok\":true,\"dryRun\":true,\"target\":\"" + EscapeJson(stdinName) +
          "\",\"stdout\":\"" + EscapeJson(stdoutName) +
          "\",\"stderr\":\"" + EscapeJson(stderrName) +
          "\",\"parentHandle\":\"0x" + parentHandleValues[selected].ToString("X") + "\"}";
      }
      byte[] bytes = Encoding.UTF8.GetBytes(jsonLine + "\n");
      uint written;
      writing = true;
      bool ok = WriteFile(parentPipes[selected], bytes, (uint)bytes.Length, out written, IntPtr.Zero);
      int error = ok ? 0 : Marshal.GetLastWin32Error();
      return "{\"ok\":" + (ok && written == bytes.Length ? "true" : "false") +
        ",\"target\":\"" + EscapeJson(stdinName) +
        "\",\"stdout\":\"" + EscapeJson(stdoutName) +
        "\",\"stderr\":\"" + EscapeJson(stderrName) +
        "\",\"parentHandle\":\"0x" + parentHandleValues[selected].ToString("X") +
        "\",\"bytes\":" + bytes.Length +
        ",\"written\":" + written +
        ",\"error\":" + error + "}";
    } finally {
      foreach (var pipe in parentPipes) CloseHandle(pipe);
      CloseHandle(parent);
    }
    } catch (Exception ex) {
      return "{\"ok\":false,\"delivery\":\"" + (writing ? "unknown" : "not-sent") +
        "\",\"error\":\"" + EscapeJson(ex.Message) + "\"}";
    }
  }

  static string EscapeJson(string value) {
    if (value == null) return "";
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
  }
}
'@

Add-Type -TypeDefinition $src
$recordPath = Join-Path $env:USERPROFILE ".claude\sessions\$ChildPid.json"
$record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($record.pid -ne $ChildPid -or $record.sessionId -cne $ExpectedSessionId -or $record.procStart -ne $ExpectedStart) { throw 'Claude runtime identity changed before pipe selection' }
[ClaudeLiveStdinWriter]::Send($ParentPid, $ChildPid, $ExpectedStart, $JsonLine, [bool]$DryRun)
