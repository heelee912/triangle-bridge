param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][int]$ChildPid,
  [Parameter(Mandatory = $true)][string]$JsonLine
)

$ErrorActionPreference = "Stop"

$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;
using System.Text.RegularExpressions;

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

  public static string Send(int parentPid, int childPid, string jsonLine) {
    var standardHandles = ReadChildStandardHandles(childPid);
    string stdoutName = QueryChildHandleName(childPid, standardHandles["stdout"]);
    string stderrName = QueryChildHandleName(childPid, standardHandles["stderr"]);
    var pattern = new Regex(@"\\uv\\(\d+)-" + Regex.Escape(parentPid.ToString()) + "$");
    var stdoutMatch = pattern.Match(stdoutName);
    var stderrMatch = pattern.Match(stderrName);
    if (!stdoutMatch.Success || !stderrMatch.Success) {
      throw new Exception("Could not infer libuv pipe set. stdout=" + stdoutName + " stderr=" + stderrName);
    }

    int stdoutIndex = int.Parse(stdoutMatch.Groups[1].Value);
    int stderrIndex = int.Parse(stderrMatch.Groups[1].Value);
    int stdinIndex = Math.Min(stdoutIndex, stderrIndex) - 1;

    var targetSuffixes = new List<string>();
    if (stdinIndex >= 0) targetSuffixes.Add("\\uv\\" + stdinIndex + "-" + parentPid);
    // Recent Claude/Electron builds can expose the app-owned stdin pipe with the libuv
    // underflow sentinel instead of the adjacent stdout/stderr index.
    string underflowSuffix = "\\uv\\" + UInt64.MaxValue.ToString() + "-" + parentPid;
    if (!targetSuffixes.Contains(underflowSuffix)) targetSuffixes.Add(underflowSuffix);

    var handles = QueryHandles();
    IntPtr parent = OpenProcess(PROCESS_DUP_HANDLE, false, parentPid);
    if (parent == IntPtr.Zero) throw new Exception("OpenProcess parent failed: " + Marshal.GetLastWin32Error());

    try {
      var observedParentPipes = new List<string>();
      foreach (var entry in handles) {
        if (entry.UniqueProcessId.ToUInt64() != (ulong)parentPid) continue;
        ulong handleValue = entry.HandleValue.ToUInt64();
        IntPtr duplicate;
        if (!DuplicateHandle(parent, new IntPtr(unchecked((long)handleValue)), GetCurrentProcess(), out duplicate, 0, false, DUPLICATE_SAME_ACCESS)) {
          continue;
        }
        try {
          if (GetFileType(duplicate) != FILE_TYPE_PIPE) continue;
          string name = QueryNameWithTimeout(duplicate, 150);
          if (name.Contains("\\uv\\")) observedParentPipes.Add(name);

          string matchedSuffix = null;
          foreach (var targetSuffix in targetSuffixes) {
            if (name.EndsWith(targetSuffix, StringComparison.OrdinalIgnoreCase)) {
              matchedSuffix = targetSuffix;
              break;
            }
          }
          if (matchedSuffix == null) continue;

          byte[] bytes = Encoding.UTF8.GetBytes(jsonLine + "\n");
          uint written;
          bool ok = WriteFile(duplicate, bytes, (uint)bytes.Length, out written, IntPtr.Zero);
          int error = Marshal.GetLastWin32Error();
          return "{\"ok\":" + (ok ? "true" : "false") +
            ",\"target\":\"" + EscapeJson(name) +
            "\",\"candidate\":\"" + EscapeJson(matchedSuffix) +
            "\",\"parentHandle\":\"0x" + handleValue.ToString("X") +
            "\",\"stdout\":\"" + EscapeJson(stdoutName) +
            "\",\"stderr\":\"" + EscapeJson(stderrName) +
            "\",\"bytes\":" + bytes.Length +
            ",\"written\":" + written +
            ",\"error\":" + error + "}";
        } finally {
          CloseHandle(duplicate);
        }
      }
      throw new Exception("Parent stdin pipe not found: suffixes=" + String.Join(",", targetSuffixes) +
        " stdout=" + stdoutName +
        " stderr=" + stderrName +
        " parentPipes=" + String.Join(",", observedParentPipes));
    } finally {
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
[ClaudeLiveStdinWriter]::Send($ParentPid, $ChildPid, $JsonLine)
