param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][int]$ChildPid,
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

  // libuv names each pipe uv\<counter>-<parentPid> and creates a child's stdin, stdout and
  // stderr back to back, so stdin is the index just before stdout. The parent's first spawn
  // underflows that counter to UInt64.MaxValue. The child's own stdin name usually cannot be
  // read because the child holds it in a blocking read, so the adjacent names are the evidence.
  public static string ExpectedStdinPipeName(int parentPid, string stdoutName, string stderrName) {
    ulong stdoutIndex = ParseLibuvPipeIndex(parentPid, stdoutName, "stdout");
    ulong stderrIndex = ParseLibuvPipeIndex(parentPid, stderrName, "stderr");
    if (stderrIndex != unchecked(stdoutIndex + 1)) {
      throw new Exception("Child stdout and stderr pipes are not adjacent (" + stdoutName + ", " + stderrName + "); refusing to infer stdin.");
    }
    return LibuvPipePrefix + unchecked(stdoutIndex - 1).ToString() + "-" + parentPid.ToString();
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

  public static string Send(int parentPid, int childPid, string jsonLine, bool dryRun) {
    var standardHandles = ReadChildStandardHandles(childPid);
    string stdoutName = QueryChildHandleName(childPid, standardHandles["stdout"]);
    string stderrName = QueryChildHandleName(childPid, standardHandles["stderr"]);
    string stdinName = ExpectedStdinPipeName(parentPid, stdoutName, stderrName);
    string observedStdinName = QueryChildHandleName(childPid, standardHandles["stdin"]);
    if (observedStdinName.StartsWith("\\Device\\", StringComparison.OrdinalIgnoreCase) &&
        !String.Equals(observedStdinName, stdinName, StringComparison.OrdinalIgnoreCase)) {
      throw new Exception("Child stdin " + observedStdinName + " disagrees with inferred " + stdinName + "; refusing to send.");
    }

    var handles = QueryHandles();
    IntPtr parent = OpenProcess(PROCESS_DUP_HANDLE, false, parentPid);
    if (parent == IntPtr.Zero) throw new Exception("OpenProcess parent failed: " + Marshal.GetLastWin32Error());

    var parentPipes = new List<IntPtr>();
    var parentPipeNames = new List<string>();
    var parentHandleValues = new List<ulong>();
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
          string name = QueryNameWithTimeout(duplicate, 150);
          if (!String.Equals(name, stdinName, StringComparison.OrdinalIgnoreCase)) continue;
          uint pipeFlags;
          if (!GetNamedPipeInfo(duplicate, out pipeFlags, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) || (pipeFlags & PIPE_SERVER_END) == 0) continue;
          parentPipes.Add(duplicate);
          parentPipeNames.Add(name);
          parentHandleValues.Add(handleValue);
          duplicate = IntPtr.Zero;
        } finally {
          if (duplicate != IntPtr.Zero) CloseHandle(duplicate);
        }
      }
      int selected = SelectStdinPipe(stdinName, parentPipeNames.ToArray());
      if (dryRun) {
        return "{\"ok\":true,\"dryRun\":true,\"target\":\"" + EscapeJson(stdinName) +
          "\",\"stdout\":\"" + EscapeJson(stdoutName) +
          "\",\"stderr\":\"" + EscapeJson(stderrName) +
          "\",\"parentHandle\":\"0x" + parentHandleValues[selected].ToString("X") + "\"}";
      }
      byte[] bytes = Encoding.UTF8.GetBytes(jsonLine + "\n");
      uint written;
      bool ok = WriteFile(parentPipes[selected], bytes, (uint)bytes.Length, out written, IntPtr.Zero);
      int error = Marshal.GetLastWin32Error();
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
  }

  static string EscapeJson(string value) {
    if (value == null) return "";
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
  }
}
'@

Add-Type -TypeDefinition $src
[ClaudeLiveStdinWriter]::Send($ParentPid, $ChildPid, $JsonLine, [bool]$DryRun)
