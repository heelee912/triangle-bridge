#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCreateCliArgs, createCodeSession, findImportedSession, resumeDeepLink } from "./claude_session_create.mjs";
import { createTranscriptTail, findPeerMessageRecord, findPeerRuntime, findSessionById, markPeerMessage, peerReceipt, probePeer, reservePeerMessage, sendPeer, waitForPeerReceipt } from "./claude_peer_transport.mjs";
import { buildVisibleUserFrame, chooseDesktopSendTransport } from './claude_visible_transport.mjs';
import { ensureDesktopReady } from './desktop_lifecycle.mjs';

const CODE_MODEL = "claude-opus-4-8";
const CODE_EFFORT = "xhigh";
const COWORK_MODEL = "claude-opus-4-8[1m]";
const COWORK_EFFORT = "max";
const DEFAULT_PERMISSION_MODE = "bypassPermissions";
const DEFAULT_BRIDGE_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_TIMEOUT_MS = 120000;
const DEFAULT_CLI_TIMEOUT_MS = 300000;
const DEFAULT_SEND_OBSERVE_TIMEOUT_MS = 45000;
const DEFAULT_MAIN_INSPECT_PORT = 9229;
const POLL_INTERVAL_MS = 2000;

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const conventionalClaudeDataDir = path.join(appData, "Claude");
const packageRoot = path.join(localAppData, "Packages");
const packageClaudeDataDirs = (() => {
  try {
    return fs
      .readdirSync(packageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("claude_"))
      .map((entry) => path.join(packageRoot, entry.name, "LocalCache", "Roaming", "Claude"));
  } catch {
    return [];
  }
})();
const claudeDataDirs = [...new Set([conventionalClaudeDataDir, ...packageClaudeDataDirs])];
const claudeDataDir = claudeDataDirs.find((candidate) => fs.existsSync(path.join(candidate, 'Local State'))) ||
  claudeDataDirs.find((candidate) => fs.existsSync(candidate)) || conventionalClaudeDataDir;
const codeSessionRoots = claudeDataDirs.map((candidate) => path.join(candidate, "claude-code-sessions"));
const coworkSessionRoots = claudeDataDirs.map((candidate) => path.join(candidate, "local-agent-mode-sessions"));
const developerSettingsPath = path.join(claudeDataDir, "developer_settings.json");
const transcriptRoot = path.join(os.homedir(), ".claude", "projects");
const claudeCodeCredentialsPath = path.join(os.homedir(), ".claude", ".credentials.json");
const claudeLocalStatePath = path.join(claudeDataDir, "Local State");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const liveStdinHelperPath = path.join(scriptDir, "claude_live_stdin.ps1");

class CliError extends Error {
  constructor(message, exitCode = 1, details = undefined) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    if (eq >= 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function routeCommand(args) {
  const first = args._[0] || "help";
  let surface = String(args.surface || "code").toLowerCase();
  let command = first.toLowerCase();
  let rest = args._.slice(1);

  if (first === "bridge" || first === "raw") {
    command = "bridge";
    rest = args._.slice(1);
    if (first === "raw") command = "raw";
  } else if (first === "code" || first === "cowork") {
    surface = first;
    command = String(args._[1] || "status").toLowerCase();
    rest = args._.slice(2);
  } else if (first.includes(":")) {
    const pieces = first.split(":");
    surface = pieces[0].toLowerCase();
    command = pieces[1]?.toLowerCase() || "status";
  }

  if (!["code", "cowork"].includes(surface)) {
    throw new CliError(`unknown surface: ${surface}`);
  }

  return { surface, command, rest };
}

function usage() {
  return `Usage:
  claude_code_bridge.mjs code app-start [--json]              Open the installed desktop app without restarting it.
  claude_code_bridge.mjs status [--cwd PATH] [--json]
  claude_code_bridge.mjs list [--cwd PATH] [--json]
  claude_code_bridge.mjs code start --prompt TEXT [--cwd PATH] [--title TEXT] [--wait]
  claude_code_bridge.mjs code send --prompt TEXT --session-id ID [--cwd PATH] [--wait] [--transport auto|renderer|raw|peer|live-stdin|cli]
  claude_code_bridge.mjs code peer-probe --session-id ID [--cwd PATH] [--json]
  claude_code_bridge.mjs code peer-receipt --session-id ID --message-id UUID [--json]
  claude_code_bridge.mjs code create --cwd PATH --prompt-file FILE [--title TEXT] [--permission-mode bypassPermissions] [--model ID] [--effort LEVEL] [--no-open] [--json]
  claude_code_bridge.mjs code wake --session-id ID [--json]     Open an idle Desktop session so its process starts.
  claude_code_bridge.mjs code set-permission-mode --session-id ID --mode default|acceptEdits|plan|auto|bypassPermissions [--dry-run] [--json]
  claude_code_bridge.mjs cowork start --prompt TEXT [--cwd PATH] [--title TEXT] [--wait]
  claude_code_bridge.mjs cowork send --prompt TEXT [--session-id local_...] [--wait]
  claude_code_bridge.mjs read [--surface code|cowork] [--cwd PATH] [--session-id local_...] [--lines N] [--json]
  claude_code_bridge.mjs wait [--surface code|cowork] [--cwd PATH] [--session-id local_...] [--timeout-ms N]
  claude_code_bridge.mjs bridge ensure [--restart-claude] [--yes] [--json]
  claude_code_bridge.mjs bridge restart --yes [--json]
  claude_code_bridge.mjs auth-sync [--json]
  claude_code_bridge.mjs raw probe [--surface code|cowork] [--json]
  claude_code_bridge.mjs raw send --prompt TEXT [--cwd PATH] [--session-id local_...] [--wait]
  claude_code_bridge.mjs raw start --prompt TEXT [--cwd PATH] [--title TEXT] [--wait]
  claude_code_bridge.mjs selftest

Renderer transport:
  --cdp-url http://127.0.0.1:PORT       Existing Claude Desktop DevTools endpoint.
  --cdp-url ws://127.0.0.1:PORT/devtools/page/ID
  --cdp-port PORT
  --main-inspect-port PORT              Existing Claude main-process inspector endpoint.
  CLAUDE_DESKTOP_CDP_URL or CLAUDE_CDP_URL
  CLAUDE_MAIN_INSPECT_PORT or CLAUDE_MAIN_INSPECT_URL

Bridge bootstrap:
  Session create/send/read/permission commands automatically open an unavailable desktop app.
  status/list stay passive unless --start-app is explicit.
  Mutating commands first try existing transports, then non-destructive attach attempts.
  --attach-only prevents bootstrap from launching another Claude Desktop instance.
  Use --restart-claude --yes to let the CLI restart Claude Desktop with --inspect.

Raw IPC transport:
  --raw-ipc                             Directly call renderer eIPC handlers from Electron main.
  raw probe                             Show LocalSessions handler registry visibility.

Code CLI resume transport:
  --transport live-stdin                Send into Claude Desktop's already-running claude-code child stdin pipe.
  --transport peer                      Use Claude's authenticated session-specific inbox. No OAuth sync or restart.
  --sender-mode bypass|prompting         Required for peer. Actual sender permissions for Claude's parity check.
  --sender-session-id ID                 Required for peer. Identifies the sending session.
  --transport cli                       Send through claude.exe --resume when Desktop bridges are unavailable.
  --no-auth-sync                        Do not sync Claude Code OAuth credentials from Claude Desktop.
  --cli-timeout-ms N                    Foreground CLI wait timeout. Default: ${DEFAULT_CLI_TIMEOUT_MS}.
  --confirm-send                        In background CLI mode, wait until the user message appears in transcript.

This CLI never patches Claude Desktop, never edits app.asar, and never uses UI/browser automation.
Default mutating commands call window["claude.web"].LocalSessions or LocalAgentModeSessions.
Raw mutating commands call the registered $eipc_message$...LocalSessions handlers directly.
Code CLI resume syncs Desktop OAuth from Claude's encrypted local token cache, then runs claude.exe --resume.`;
}

function toBool(value) {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function toInt(value, fallback) {
  if (value === undefined || value === null || value === true) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizeFilePath(value) {
  if (!value) return "";
  return path.resolve(String(value)).replace(/\//g, "\\").toLowerCase();
}

function resolveCwd(value) {
  return path.resolve(String(value || process.cwd()));
}

function encodeProjectPath(cwd) {
  return path.resolve(cwd).replace(/[:\\/]/g, "-");
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function walkFiles(root, predicate, maxFiles = 10000) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (predicate(full, entry)) {
        out.push(full);
      }
    }
  }
  return out;
}

function walkFilesFromRoots(roots, predicate, maxFiles = 10000) {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    for (const filePath of walkFiles(root, predicate, maxFiles - out.length)) {
      const key = normalizeFilePath(filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(filePath);
      if (out.length >= maxFiles) return out;
    }
  }
  return out;
}

function mtimeMs(filePath) {
  return safeStat(filePath)?.mtimeMs || 0;
}

function summarizeCodeSession(filePath) {
  const raw = readJsonFile(filePath);
  const sessionId = raw.sessionId || raw.id || path.basename(filePath, ".json");
  return {
    surface: "code",
    sessionId,
    cliSessionId: raw.cliSessionId || raw.claudeSessionId || raw.sessionUuid || null,
    cwd: raw.cwd || raw.workingDirectory || raw.projectPath || null,
    title: raw.title || raw.name || null,
    model: raw.model || raw.sessionSettings?.model || null,
    effort: raw.effort || raw.sessionSettings?.effort || raw.sessionSettings?.effortLevel || null,
    ultracode: raw.sessionSettings?.ultracode === true || raw.settings?.ultracode === true,
    permissionMode: raw.permissionMode || raw.sessionSettings?.permissionMode || null,
    updatedAt: raw.updatedAt || raw.lastActivityAt || raw.modifiedAt || null,
    createdAt: raw.createdAt || null,
    filePath,
    mtimeMs: mtimeMs(filePath),
  };
}

function summarizeCoworkSession(filePath) {
  const raw = readJsonFile(filePath);
  const sessionId = raw.sessionId || raw.id || path.basename(filePath, ".json");
  const folders = [
    ...(Array.isArray(raw.userSelectedFolders) ? raw.userSelectedFolders : []),
    ...(Array.isArray(raw.selectedFolders) ? raw.selectedFolders : []),
    ...(Array.isArray(raw.folders) ? raw.folders : []),
  ].filter(Boolean);
  return {
    surface: "cowork",
    sessionId,
    cwd: raw.cwd || raw.workingDirectory || folders[0] || null,
    folders,
    title: raw.title || raw.name || null,
    model: raw.model || raw.overrideModel || raw.sessionSettings?.model || null,
    effort: raw.effort || raw.sessionSettings?.effort || raw.flags?.effortLevel || null,
    permissionMode: raw.permissionMode || raw.sessionSettings?.permissionMode || null,
    messageCount: Array.isArray(raw.messageBuffer) ? raw.messageBuffer.length : null,
    updatedAt: raw.updatedAt || raw.lastActivityAt || raw.modifiedAt || null,
    createdAt: raw.createdAt || null,
    filePath,
    mtimeMs: mtimeMs(filePath),
  };
}

function listCodeSessions({ cwd } = {}) {
  const normalizedCwd = cwd ? normalizeFilePath(cwd) : "";
  const files = walkFilesFromRoots(
    codeSessionRoots,
    (filePath) => path.basename(filePath).startsWith("local_") && filePath.endsWith(".json"),
  );
  return files
    .map((filePath) => {
      try {
        return summarizeCodeSession(filePath);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((session) => {
      if (!normalizedCwd) return true;
      return normalizeFilePath(session.cwd) === normalizedCwd;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listCoworkSessions({ cwd } = {}) {
  const normalizedCwd = cwd ? normalizeFilePath(cwd) : "";
  const files = walkFilesFromRoots(
    coworkSessionRoots,
    (filePath) => path.basename(filePath).startsWith("local_") && filePath.endsWith(".json"),
  );
  return files
    .map((filePath) => {
      try {
        return summarizeCoworkSession(filePath);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((session) => {
      if (!normalizedCwd) return true;
      const candidates = [session.cwd, ...(session.folders || [])].filter(Boolean);
      return candidates.some((candidate) => normalizeFilePath(candidate) === normalizedCwd);
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listSessions(surface, options = {}) {
  return surface === "cowork" ? listCoworkSessions(options) : listCodeSessions(options);
}

function resolveSession(surface, args) {
  const cwd = args.cwd ? resolveCwd(args.cwd) : undefined;
  const sessions = listSessions(surface, { cwd });
  const sessionId = args["session-id"] || args.sessionId;
  if (sessionId) {
    const exact = findSessionById(listSessions(surface), sessionId);
    if (cwd && normalizeFilePath(exact.cwd) !== normalizeFilePath(cwd)) throw new CliError("Explicit Claude session does not match --cwd");
    return exact;
  }
  if (!sessions.length) {
    throw new CliError(`no ${surface} sessions found${cwd ? ` for cwd ${cwd}` : ""}`);
  }
  return sessions[0];
}

function codeTranscriptPath(session) {
  if (!session.cwd || !session.cliSessionId) return null;
  const expected = path.join(transcriptRoot, encodeProjectPath(session.cwd), `${session.cliSessionId}.jsonl`);
  if (safeStat(expected)) return expected;
  const matches = walkFiles(
    transcriptRoot,
    (filePath) => path.basename(filePath) === `${session.cliSessionId}.jsonl`,
    10000,
  ).sort((a, b) => mtimeMs(b) - mtimeMs(a));
  return matches[0] || expected;
}

function readJsonl(filePath) {
  const stat = safeStat(filePath);
  if (!stat) return [];
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { role: "raw", text: line };
      }
    });
}

function messageRole(entry) {
  return entry.message?.role || entry.role || entry.type || "unknown";
}

function blockText(block) {
  if (!block) return "";
  if (typeof block === "string") return block;
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (block.type === "tool_use") return toolUseText(block);
  if (block.type === "tool_result") return "[tool_result]";
  return "";
}

function truncateText(value, maxChars = 1200) {
  const text = String(value || "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function toolUseText(block) {
  const name = block.name || block.id || "unknown";
  if (name !== "AskUserQuestion") return `[tool_use:${name}]`;

  const questions = Array.isArray(block.input?.questions) ? block.input.questions : [];
  if (!questions.length) {
    return `[tool_use:${name}]\n${truncateText(JSON.stringify(block.input || {}, null, 2), 2000)}`;
  }

  const renderedQuestions = questions.map((question, index) => {
    const header = question.header ? ` (${question.header})` : "";
    const lines = [`Question ${index + 1}${header}: ${question.question || ""}`];
    const options = Array.isArray(question.options) ? question.options : [];
    for (const option of options) {
      const label = option.label || "";
      const description = option.description ? ` - ${option.description}` : "";
      lines.push(`- ${label}${description}`);
    }
    return lines.join("\n");
  });

  return `[tool_use:${name}]\n${truncateText(renderedQuestions.join("\n\n"), 4000)}`;
}

function messageText(entry) {
  if (typeof entry.text === "string") return entry.text;
  const message = entry.message || entry;
  const content = message.content ?? message.message ?? message.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(blockText).filter(Boolean).join("\n");
  }
  return "";
}

function entryTimeMs(entry) {
  const value =
    entry.timestamp ||
    entry.createdAt ||
    entry.created_at ||
    entry.message?.timestamp ||
    entry.message?.createdAt ||
    null;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTranscriptEntries(entries) {
  return entries
    .map((entry) => ({
      role: messageRole(entry),
      text: messageText(entry),
      timestampMs: entryTimeMs(entry),
      raw: entry,
    }))
    .filter((entry) => {
      const role = String(entry.role).toLowerCase();
      return entry.text && ["assistant", "system", "user"].includes(role);
    });
}

function readLocalTranscript(surface, args) {
  const session = resolveSession(surface, args);
  if (surface === "cowork") {
    const raw = readJsonFile(session.filePath);
    const entries = Array.isArray(raw.messageBuffer)
      ? raw.messageBuffer
      : Array.isArray(raw.messages)
        ? raw.messages
        : [];
    return { session, entries: normalizeTranscriptEntries(entries), source: session.filePath };
  }

  const transcriptPath = codeTranscriptPath(session);
  if (!transcriptPath) {
    return { session, entries: [], source: null };
  }
  return {
    session,
    entries: normalizeTranscriptEntries(readJsonl(transcriptPath)),
    source: transcriptPath,
  };
}

function titleFromPrompt(prompt) {
  const compact = String(prompt || "").replace(/\s+/g, " ").trim();
  if (!compact) return "Codex Bridge";
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function readPrompt(args, rest = []) {
  if (typeof args.prompt === "string") return args.prompt;
  if (typeof args["prompt-file"] === "string") {
    return fs.readFileSync(args["prompt-file"], "utf8");
  }
  if (rest.length) return rest.join(" ");
  return "";
}

function newLocalSessionId() {
  return `local_${crypto.randomUUID()}`;
}

function buildStartPayload(surface, args, prompt) {
  const sessionId = args["session-id"] || args.sessionId || newLocalSessionId();
  const title = args.title || titleFromPrompt(prompt);
  if (surface === "cowork") {
    const cwd = args.cwd ? resolveCwd(args.cwd) : undefined;
    return {
      payload: {
        message: "",
        sessionId,
        model: COWORK_MODEL,
        permissionMode: DEFAULT_PERMISSION_MODE,
        title,
        userSelectedFolders: cwd ? [cwd] : [],
        userSelectedFiles: [],
        images: [],
        messageUuid: crypto.randomUUID(),
        channel: "codex-claude-code-bridge",
      },
      sessionId,
    };
  }

  return {
    payload: {
      cwd: resolveCwd(args.cwd),
      message: "",
      sessionId,
      model: CODE_MODEL,
      effort: CODE_EFFORT,
      useWorktree: false,
      title,
      permissionMode: DEFAULT_PERMISSION_MODE,
      images: [],
      attachments: [],
      mcpServers: [],
      remoteMcpServers: [],
      additionalDirectories: [],
      classifierSummaryEnabled: true,
      rendererSurface: "codex-claude-code-bridge",
    },
    sessionId,
  };
}

function buildForceOperations(surface, sessionId) {
  if (surface === "cowork") {
    return [
      { method: "setModel", args: [sessionId, COWORK_MODEL] },
      { method: "setEffort", args: [sessionId, COWORK_EFFORT] },
    ];
  }

  return [
    { method: "setModel", args: [sessionId, CODE_MODEL] },
    { method: "setEffort", args: [sessionId, CODE_EFFORT] },
    { method: "applyFlagSettings", args: [sessionId, { ultracode: true, effortLevel: CODE_EFFORT }] },
  ];
}

function buildSendArgs(surface, sessionId, prompt) {
  if (surface === "cowork") {
    return [sessionId, prompt, [], [], crypto.randomUUID(), []];
  }
  return [sessionId, prompt, [], [], []];
}

function apiNameForSurface(surface) {
  return surface === "cowork" ? "LocalAgentModeSessions" : "LocalSessions";
}

function defaultsForSurface(surface) {
  if (surface === "cowork") {
    return { model: COWORK_MODEL, effort: COWORK_EFFORT, permissionMode: DEFAULT_PERMISSION_MODE };
  }
  return {
    model: CODE_MODEL,
    effort: CODE_EFFORT,
    ultracode: true,
    permissionMode: DEFAULT_PERMISSION_MODE,
  };
}

function listClaudeProcesses() {
  if (process.platform !== "win32") return [];
  const command = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -like '*Claude*' -or $_.ExecutablePath -like '*Claude*' -or $_.CommandLine -like '*claude-code*' } |
  Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate |
  ConvertTo-Json -Compress -Depth 4
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function processCreationDateMs(proc) {
  const raw = proc?.CreationDate || proc?.creationDate;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;

  const text = String(raw);
  const dotNetDate = text.match(/\/Date\((-?\d+)\)\//);
  if (dotNetDate) return Number.parseInt(dotNetDate[1], 10);

  const cimDate = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)/);
  if (cimDate) {
    const [, year, month, day, hour, minute, second, fraction] = cimDate;
    const ms = Number.parseInt(fraction.slice(0, 3).padEnd(3, "0"), 10);
    return new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
      ms,
    ).getTime();
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function isClaudeDesktopProcess(proc) {
  const exe = lower(proc.ExecutablePath || proc.executablePath);
  const cmd = lower(proc.CommandLine || proc.commandLine);
  if (!exe.endsWith("\\claude.exe")) return false;
  if (exe.includes("\\appdata\\roaming\\claude\\claude-code\\")) return false;
  if (exe.includes("\\localcache\\roaming\\claude\\claude-code\\")) return false;
  if (!exe.includes("\\windowsapps\\claude_") && !cmd.includes("\\resources\\app.asar")) return false;
  return true;
}

function isClaudeDesktopMainProcess(proc) {
  if (!isClaudeDesktopProcess(proc)) return false;
  const cmd = lower(proc.CommandLine || proc.commandLine);
  return !cmd.includes("--type=");
}

function listClaudeDesktopProcesses() {
  return listClaudeProcesses().filter(isClaudeDesktopProcess);
}

function listClaudeDesktopMainProcesses() {
  return listClaudeProcesses().filter(isClaudeDesktopMainProcess);
}

function findClaudeDesktopExecutable() {
  const main = listClaudeDesktopMainProcesses()[0];
  if (main?.ExecutablePath && fs.existsSync(main.ExecutablePath)) return main.ExecutablePath;

  const candidates = [];
  const windowsApps = path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
  try {
    for (const entry of fs.readdirSync(windowsApps, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.toLowerCase().startsWith("claude_")) continue;
      const exe = path.join(windowsApps, entry.name, "app", "Claude.exe");
      const stat = safeStat(exe);
      if (stat) candidates.push({ exe, mtimeMs: stat.mtimeMs });
    }
  } catch {
    // WindowsApps can be unreadable on some systems. Fall back to process list only.
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.exe || null;
}

function isClaudeCodeCliProcess(proc) {
  const exe = lower(proc.ExecutablePath || proc.executablePath);
  return (
    exe.endsWith("\\claude.exe") &&
    (exe.includes("\\appdata\\roaming\\claude\\claude-code\\") ||
      exe.includes("\\localcache\\roaming\\claude\\claude-code\\"))
  );
}

function listClaudeCodeCliProcesses() {
  return listClaudeProcesses().filter(isClaudeCodeCliProcess);
}

function findLiveClaudeCodeProcessForSession(session, processes = listClaudeCodeCliProcesses()) {
  if (!session?.cliSessionId) return null;
  const cliSessionId = lower(session.cliSessionId);
  const matches = processes.filter((proc) => {
    const commandLine = lower(proc.CommandLine || proc.commandLine);
    const identifiers = [...commandLine.matchAll(/(?:^|\s)--(?:resume|session-id)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)]
      .map((match) => match[1] ?? match[2] ?? match[3]);
    return identifiers.length > 0 && identifiers.every((identifier) => identifier === cliSessionId);
  });
  // Creation time and model settings do not establish session identity.
  return matches.length === 1 ? matches[0] : null;
}

function findDesktopParentPidForCodeProcess(proc) {
  const parentPid = Number(proc?.ParentProcessId || proc?.parentProcessId || 0);
  if (parentPid) return parentPid;
  const main = listClaudeDesktopMainProcesses()[0];
  return Number(main?.ProcessId || main?.processId || 0) || null;
}

function compareVersionLike(a, b) {
  const left = String(a).split(".").map((piece) => Number.parseInt(piece, 10) || 0);
  const right = String(b).split(".").map((piece) => Number.parseInt(piece, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function findClaudeCodeExecutable() {
  const running = listClaudeCodeCliProcesses()
    .map((proc) => proc.ExecutablePath || proc.executablePath)
    .find((exe) => exe && fs.existsSync(exe));
  if (running) return running;

  const candidates = [];
  for (const dataDir of claudeDataDirs) {
    const root = path.join(dataDir, 'claude-code');
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const versionDir = path.join(root, entry.name);
        const locations = [versionDir, ...fs.readdirSync(versionDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(versionDir, e.name))];
        for (const location of locations) {
          const exe = path.join(location, 'claude.exe');
          const stat = safeStat(exe);
          if (stat) candidates.push({ exe, version: entry.name, mtimeMs: stat.mtimeMs });
        }
      }
    } catch { /* A packaged app can virtualize the conventional profile path. */ }
  }
  candidates.sort((a, b) => compareVersionLike(b.version, a.version) || b.mtimeMs - a.mtimeMs);
  return candidates[0]?.exe || null;
}

function decryptDpapiBase64(base64Value) {
  const command = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${String(base64Value).replace(/'/g, "''")}')
if ([System.Text.Encoding]::ASCII.GetString($bytes[0..4]) -eq 'DPAPI') {
  $bytes = $bytes[5..($bytes.Length - 1)]
}
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Write([Convert]::ToBase64String($plain))
`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  }).trim();
}

function decryptChromiumV10(base64Ciphertext, key) {
  const blob = Buffer.from(base64Ciphertext, "base64");
  const prefix = blob.subarray(0, 3).toString("ascii");
  if (prefix !== "v10") {
    throw new CliError(`unsupported encrypted blob prefix: ${prefix || "empty"}`);
  }
  const nonce = blob.subarray(3, 15);
  const ciphertext = blob.subarray(15, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function readDesktopOauthTokenCache() {
  if (process.platform !== "win32") {
    throw new CliError("Desktop OAuth sync currently supports Windows only");
  }
  if (!fs.existsSync(claudeLocalStatePath)) {
    throw new CliError(`Claude Local State not found: ${claudeLocalStatePath}`);
  }
  const config = readJsonFile(path.join(claudeDataDir, "config.json"));
  const encryptedTokenCache = config["oauth:tokenCache"];
  if (!encryptedTokenCache) {
    throw new CliError("Claude Desktop oauth:tokenCache is missing");
  }
  const localState = readJsonFile(claudeLocalStatePath);
  const encryptedKey = localState?.os_crypt?.encrypted_key;
  if (!encryptedKey) {
    throw new CliError("Claude Desktop os_crypt.encrypted_key is missing");
  }

  const key = Buffer.from(decryptDpapiBase64(encryptedKey), "base64");
  return JSON.parse(decryptChromiumV10(encryptedTokenCache, key));
}

function selectDesktopClaudeCodeOauth(cache) {
  const candidates = Object.entries(cache)
    .filter(([key, value]) => {
      return (
        key.includes("user:sessions:claude_code") &&
        typeof value?.token === "string" &&
        value.token.length > 0
      );
    })
    .sort((a, b) => (b[1].expiresAt || 0) - (a[1].expiresAt || 0));
  if (!candidates.length) {
    throw new CliError("no Desktop OAuth token with user:sessions:claude_code scope found");
  }
  const [cacheKey, token] = candidates[0];
  const scopes = cacheKey.split(":").slice(4).join(":").split(/\s+/).filter(Boolean);
  return { cacheKey, token, scopes };
}

function selectDesktopInferenceToken(cache) {
  // Claude Desktop now keeps long-lived user:inference tokens for its Code children.
  const candidates = Object.entries(cache)
    .filter(([key, value]) => /(?:^|[\s:])user:inference(?:\s|$)/.test(key) && typeof value?.token === "string" && value.token.length > 0)
    .sort((a, b) => (b[1].expiresAt || 0) - (a[1].expiresAt || 0));
  if (!candidates.length) throw new CliError("no Desktop OAuth token with user:inference scope found");
  return candidates[0][1].token;
}

function runCliWithStdin(executablePath, cliArgs, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executablePath, cliArgs, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      reject(new CliError("Claude Code first turn timed out", 3, { timeoutMs, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) }));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(Buffer.from(input, "utf8"));
  });
}

function claudeDesktopExecutionAlias() {
  const alias = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Microsoft", "WindowsApps", "claude-desktop.exe");
  // App execution aliases are reparse points that fs.existsSync cannot stat; lstat sees them.
  try { fs.lstatSync(alias); return alias; } catch { return null; }
}

function openClaudeDeepLink(url) {
  if (!/^claude:\/\/[a-z.-]+(?:\/[A-Za-z0-9_\/-]*)?(?:\?[A-Za-z0-9=%&._-]+)?$/.test(url)) throw new CliError(`refusing to open unexpected deep link: ${url}`);
  const alias = claudeDesktopExecutionAlias();
  if (alias) {
    // The packaged app's execution alias forwards the URL to the running instance as a
    // second-instance argument. Windows protocol activation from a background process
    // instead shows a "switch apps" confirmation that the user must click.
    execFileSync(alias, [url], { windowsHide: true, stdio: "ignore", timeout: 30000 });
    return "execution-alias";
  }
  execFileSync("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true });
  return "protocol-handler";
}

function applyRuntimePermissionMode(session, mode, { dryRun = false } = {}) {
  const requestId = crypto.randomUUID();
  const frame = buildPermissionModeControlFrame(mode, requestId);
  const { liveProcess, childPid, parentPid } = resolveLiveCodeProcess(session);
  const blocker = permissionModeLaunchBlocker(liveProcess.CommandLine || liveProcess.commandLine, mode);
  if (blocker) throw new CliError(blocker, 2, { childPid });
  const helper = runLiveStdinHelper(parentPid, childPid, frame, { dryRun });
  if (!helper.ok) throw new CliError("live-stdin helper failed to write the permission mode request", 2, helper);
  return { requestId, parentPid, childPid, helper };
}

async function enforceDesktopPermissionMode(cliSessionId, mode, timeoutMs) {
  // Claude Desktop downgrades an imported bypass session to acceptEdits. Once Desktop has
  // launched the session process, the same set_permission_mode control request the SDK uses
  // switches it, and Desktop records the mode the process reports.
  const session = await waitForCondition(() => {
    const found = findImportedSession(listSessions("code"), cliSessionId);
    return found && findLiveClaudeCodeProcessForSession(found) ? found : null;
  }, timeoutMs).catch(() => null);
  if (!session) return { applied: false, reason: "Claude Desktop did not start the session process" };
  const runtime = applyRuntimePermissionMode(session, mode);
  const recorded = await waitForCondition(() => {
    const current = findImportedSession(listSessions("code"), cliSessionId);
    return current?.permissionMode === mode ? current : null;
  }, timeoutMs).catch(() => null);
  return { applied: !!recorded, childPid: runtime.childPid, requestId: runtime.requestId, desktopRecordedMode: recorded?.permissionMode || null };
}

async function cmdCreate(args, surface, rest) {
  if (surface !== "code") throw new CliError("create only supports Code sessions");
  if (!args.cwd) throw new CliError("code create requires --cwd");
  const prompt = readPrompt(args, rest);
  const executablePath = findClaudeCodeExecutable();
  if (!executablePath) throw new CliError("Claude Desktop claude.exe was not found");
  const recentDesktop = listSessions("code").sort((x, y) => (Number(y.updatedAt) || 0) - (Number(x.updatedAt) || 0))[0];
  const result = await createCodeSession(
    {
      cwd: resolveCwd(args.cwd),
      prompt,
      title: args.title,
      // A new session follows the model the user currently runs in Desktop, not a hard-coded default.
      model: args.model || recentDesktop?.model,
      effort: args.effort || recentDesktop?.effort,
      permissionMode: args["permission-mode"] || "bypassPermissions",
      timeoutMs: toInt(args["timeout-ms"], DEFAULT_CLI_TIMEOUT_MS),
      importTimeoutMs: toInt(args["import-timeout-ms"], 30000),
      open: !toBool(args["no-open"]),
    },
    {
      executablePath,
      inferenceToken: () => selectDesktopInferenceToken(readDesktopOauthTokenCache()),
      runCli: runCliWithStdin,
      transcriptPath: (cwd, sessionId) => path.join(transcriptRoot, encodeProjectPath(cwd), `${sessionId}.jsonl`),
      openUrl: openClaudeDeepLink,
      listCodeSessions: () => listSessions("code"),
    },
  );
  let permission = null;
  if (result.desktopImported && result.permissionMode !== "acceptEdits" && result.desktopPermissionMode !== result.permissionMode) {
    permission = await enforceDesktopPermissionMode(result.cliSessionId, result.permissionMode, toInt(args["import-timeout-ms"], 30000));
  }
  const finalMode = findImportedSession(listSessions("code"), result.cliSessionId)?.permissionMode || result.desktopPermissionMode;
  printJson({ ok: !permission || permission.applied, executablePath, ...result, desktopPermissionMode: finalMode, permissionEnforcement: permission });
}

function syncClaudeCodeCredentialsFromDesktop(args = {}) {
  if (toBool(args["no-auth-sync"]) || toBool(args.noAuthSync)) {
    return { ok: true, skipped: true, reason: "--no-auth-sync" };
  }
  const cache = readDesktopOauthTokenCache();
  const selected = selectDesktopClaudeCodeOauth(cache);
  const credentials = fs.existsSync(claudeCodeCredentialsPath) ? readJsonFile(claudeCodeCredentialsPath) : {};
  const previous = credentials.claudeAiOauth || {};
  const alreadySynced =
    previous.accessToken === selected.token.token &&
    previous.refreshToken === (selected.token.refreshToken || previous.refreshToken || "") &&
    previous.expiresAt === selected.token.expiresAt;

  let backupPath = null;
  if (!alreadySynced && fs.existsSync(claudeCodeCredentialsPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${claudeCodeCredentialsPath}.codex-backup-${stamp}`;
    fs.copyFileSync(claudeCodeCredentialsPath, backupPath);
  }

  credentials.claudeAiOauth = {
    ...previous,
    accessToken: selected.token.token,
    refreshToken: selected.token.refreshToken || previous.refreshToken || "",
    expiresAt: selected.token.expiresAt,
    scopes: selected.scopes,
    subscriptionType: selected.token.subscriptionType || previous.subscriptionType || null,
    rateLimitTier: selected.token.rateLimitTier || previous.rateLimitTier || null,
  };
  fs.mkdirSync(path.dirname(claudeCodeCredentialsPath), { recursive: true });
  fs.writeFileSync(claudeCodeCredentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");

  return {
    ok: true,
    skipped: false,
    changed: !alreadySynced,
    credentialsPath: claudeCodeCredentialsPath,
    backupPath,
    expiresAt: selected.token.expiresAt,
    scopes: selected.scopes,
    accessTokenLength: selected.token.token.length,
    refreshTokenLength: (selected.token.refreshToken || "").length,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(fn, timeoutMs, intervalMs = 500) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

function launchClaudeDesktopWithInspector(port = DEFAULT_MAIN_INSPECT_PORT) {
  const exe = findClaudeDesktopExecutable();
  if (!exe) throw new CliError("Claude Desktop executable not found");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--inspect=${port}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
  return { exe, pid: child.pid, port };
}

function stopClaudeDesktopProcesses() {
  const processes = listClaudeDesktopProcesses();
  const pids = processes.map((proc) => Number(proc.ProcessId)).filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!pids.length) return { stopped: [], alreadyStopped: true };

  const command = `
$ErrorActionPreference = 'SilentlyContinue'
$ids = @(${pids.join(",")})
foreach ($id in $ids) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  return { stopped: pids, alreadyStopped: false };
}

function tryDebugExistingMainProcess(proc) {
  const pid = Number(proc?.ProcessId);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: "no pid" };
  if (typeof process._debugProcess !== "function") {
    return { ok: false, reason: "process._debugProcess unavailable" };
  }
  try {
    process._debugProcess(pid);
    return { ok: true, pid };
  } catch (error) {
    return { ok: false, pid, reason: String(error.message || error) };
  }
}

function discoverClaudeListenPorts() {
  if (process.env.CLAUDE_BRIDGE_ENABLE_NETTCP_DISCOVERY !== "1") return [];
  if (process.platform !== "win32") return [];
  const command = `
$ErrorActionPreference = 'SilentlyContinue'
Get-NetTCPConnection -State Listen |
  ForEach-Object {
    $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and (($proc.ProcessName -like '*Claude*') -or ($proc.Path -like '*Claude*'))) {
      [PSCustomObject]@{
        port = $_.LocalPort
        processId = $_.OwningProcess
        processName = $proc.ProcessName
        path = $proc.Path
      }
    }
  } |
  ConvertTo-Json -Compress -Depth 4
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function normalizeCdpBaseUrl(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith("ws://") || raw.startsWith("wss://")) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw.replace(/\/+$/, "");
  if (/^\d+$/.test(raw)) return `http://127.0.0.1:${raw}`;
  return raw;
}

function cdpCandidates(args) {
  const candidates = [];
  const explicit = [
    args["cdp-url"],
    args.cdpUrl,
    args["devtools-url"],
    process.env.CLAUDE_DESKTOP_CDP_URL,
    process.env.CLAUDE_CDP_URL,
  ]
    .map(normalizeCdpBaseUrl)
    .filter(Boolean);

  for (const value of explicit) {
    candidates.push({ kind: value.startsWith("ws") ? "cdp-ws" : "cdp-http", url: value, source: "explicit" });
  }

  const port = args["cdp-port"] || args.cdpPort || process.env.CLAUDE_DESKTOP_CDP_PORT;
  if (port) {
    candidates.push({ kind: "cdp-http", url: `http://127.0.0.1:${port}`, source: "port" });
  }

  for (const item of discoverClaudeListenPorts()) {
    if (item.port) {
      candidates.push({
        kind: "cdp-http",
        url: `http://127.0.0.1:${item.port}`,
        source: "claude-listener",
        processId: item.processId,
        processName: item.processName,
      });
    }
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function resolveCdpWsUrl(candidate, timeoutMs) {
  if (candidate.url.startsWith("ws://") || candidate.url.startsWith("wss://")) {
    return { wsUrl: candidate.url, target: null };
  }

  const targets = await fetchJson(`${candidate.url}/json/list`, timeoutMs);
  const list = Array.isArray(targets) ? targets : [];
  const scored = list
    .filter((target) => target.webSocketDebuggerUrl)
    .map((target) => ({ target, score: scoreCdpTarget(target) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) {
    throw new Error("no debuggable renderer target");
  }
  return { wsUrl: scored[0].target.webSocketDebuggerUrl, target: scored[0].target };
}

function scoreCdpTarget(target) {
  const text = `${target.type || ""} ${target.title || ""} ${target.url || ""}`.toLowerCase();
  let score = 0;
  if (target.type === "page") score += 10;
  if (text.includes("claude")) score += 50;
  if (text.includes("electron")) score += 20;
  if (text.includes("localhost")) score += 5;
  if (text.includes("devtools")) score -= 10;
  return score;
}

async function openWebSocket(wsUrl, timeoutMs) {
  if (typeof WebSocket !== "function") {
    throw new Error("Node runtime has no WebSocket implementation");
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      reject(new Error("websocket open timeout"));
    }, timeoutMs);

    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("websocket connection error"));
      },
      { once: true },
    );
  });
}

async function messageDataToText(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

let cdpMessageId = 1;

async function cdpRequest(ws, method, params, timeoutMs) {
  const id = cdpMessageId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${method} timeout`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
    };

    const onError = () => {
      cleanup();
      reject(new Error(`${method} websocket error`));
    };

    const onMessage = async (event) => {
      let message;
      try {
        message = JSON.parse(await messageDataToText(event.data));
      } catch {
        return;
      }
      if (message.id !== id) return;
      cleanup();
      if (message.error) {
        reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
    };

    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function cdpEvaluate(wsUrl, expression, timeoutMs) {
  const ws = await openWebSocket(wsUrl, timeoutMs);
  try {
    const result = await cdpRequest(
      ws,
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutMs,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate exception");
    }
    const remote = result.result || {};
    if (Object.prototype.hasOwnProperty.call(remote, "value")) return remote.value;
    if (Object.prototype.hasOwnProperty.call(remote, "unserializableValue")) return remote.unserializableValue;
    return null;
  } finally {
    try {
      ws.close();
    } catch {
      // ignore close errors
    }
  }
}

function normalizeInspectorUrl(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith("ws://") || raw.startsWith("wss://")) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw.replace(/\/+$/, "");
  if (/^\d+$/.test(raw)) return `http://127.0.0.1:${raw}`;
  return raw;
}

function inspectorCandidates(args) {
  const candidates = [];
  const explicit = [
    args["main-inspect-url"],
    args.mainInspectUrl,
    args["inspect-url"],
    process.env.CLAUDE_MAIN_INSPECT_URL,
  ]
    .map(normalizeInspectorUrl)
    .filter(Boolean);

  for (const value of explicit) {
    candidates.push({
      kind: value.startsWith("ws") ? "main-inspector-ws" : "main-inspector-http",
      url: value,
      source: "explicit",
    });
  }

  const port =
    args["main-inspect-port"] ||
    args.mainInspectPort ||
    args["inspect-port"] ||
    process.env.CLAUDE_MAIN_INSPECT_PORT ||
    process.env.NODE_INSPECT_PORT;
  if (port) {
    candidates.push({
      kind: "main-inspector-http",
      url: `http://127.0.0.1:${port}`,
      source: "port",
    });
  }

  candidates.push({
    kind: "main-inspector-http",
    url: "http://127.0.0.1:9229",
    source: "default-9229",
  });

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveInspectorWsUrl(candidate, timeoutMs) {
  if (candidate.url.startsWith("ws://") || candidate.url.startsWith("wss://")) {
    return { wsUrl: candidate.url, target: null };
  }
  const targets = await fetchJson(`${candidate.url}/json/list`, timeoutMs);
  const list = Array.isArray(targets) ? targets : [];
  const target = list.find((item) => item.webSocketDebuggerUrl) || null;
  if (!target) throw new Error("main inspector has no debuggee");
  return { wsUrl: target.webSocketDebuggerUrl, target };
}

async function inspectorEvalInMain(wsUrl, body, timeoutMs) {
  const expression =
    "globalThis.__codexClaudeBridgeEval = (async () => { " +
    "const __value = await (async () => { " +
    body +
    " })(); " +
    "return JSON.stringify(__value === undefined ? null : __value); " +
    "})(); globalThis.__codexClaudeBridgeEval;";
  const value = await cdpEvaluate(wsUrl, expression, timeoutMs);
  if (typeof value !== "string") {
    throw new Error(`main inspector expected JSON string, got ${typeof value}`);
  }
  return JSON.parse(value);
}

function mainEvaluateRendererBody(rendererExpression, urlFilters = ["claude.ai", "claude.com", "localhost"]) {
  return `
    const { webContents } = process.mainModule.require('electron');
    const filters = ${JSON.stringify(urlFilters)};
    const all = webContents.getAllWebContents();
    const target = all.find((wc) => {
      const url = wc.getURL();
      return filters.some((filter) => url.includes(filter));
    });
    if (!target) {
      throw new Error('no Claude renderer webContents found; urls=' + all.map((wc) => wc.getURL()).join(', '));
    }
    return await target.executeJavaScript(${JSON.stringify(rendererExpression)});
  `;
}

function eipcRegistryProbeBody(expectedSuffixes, urlFilters = ["claude.ai", "claude.com", "localhost"]) {
  return `
    const { webContents } = process.mainModule.require('electron');
    const filters = ${JSON.stringify(urlFilters)};
    const expected = ${JSON.stringify(expectedSuffixes)};
    const framed = /^\\$eipc_message\\$_[0-9a-f-]+_\\$_(.+)$/;
    const all = webContents.getAllWebContents();
    const reports = [];
    const matched = {};
    for (const suffix of expected) matched[suffix] = [];
    for (const wc of all) {
      const url = wc.getURL();
      if (filters.length && !filters.some((filter) => url.includes(filter))) continue;
      const ipc = wc.ipc;
      const map = ipc && ipc._invokeHandlers;
      const keys = map
        ? (typeof map.keys === 'function' ? Array.from(map.keys()) : Object.keys(map))
        : [];
      const suffixes = [];
      for (const key of keys) {
        const m = framed.exec(key);
        if (!m) continue;
        suffixes.push(m[1]);
        for (const expectedSuffix of expected) {
          if (m[1].endsWith(expectedSuffix)) {
            matched[expectedSuffix].push({
              webContentsId: wc.id,
              url,
              fullKey: key,
              suffix: m[1],
            });
          }
        }
      }
      reports.push({
        id: wc.id,
        url,
        type: wc.getType ? wc.getType() : 'unknown',
        hasIpc: Boolean(ipc),
        totalHandlers: keys.length,
        framedHandlers: suffixes.length,
        scopes: Array.from(new Set(suffixes.map((s) => s.split('_$_')[0]))).sort(),
      });
    }
    return {
      webContents: reports,
      expected: Object.fromEntries(Object.entries(matched).map(([suffix, hits]) => [suffix, {
        present: hits.length > 0,
        hits,
      }])),
    };
  `;
}

function expectedEipcSuffixes(surface) {
  if (surface === "cowork") {
    return [
      "LocalAgentModeSessions_$_getAll",
      "LocalAgentModeSessions_$_start",
      "LocalAgentModeSessions_$_sendMessage",
      "LocalAgentModeSessions_$_setModel",
      "LocalAgentModeSessions_$_setEffort",
      "LocalAgentModeSessions_$_getTranscript",
    ];
  }
  return [
    "LocalSessions_$_getAll",
    "LocalSessions_$_start",
    "LocalSessions_$_sendMessage",
    "LocalSessions_$_setModel",
    "LocalSessions_$_setEffort",
    "LocalSessions_$_applyFlagSettings",
    "LocalSessions_$_getTranscript",
  ];
}

function rendererProbeExpression() {
  return `(() => {
  const root = globalThis["claude.web"] || (globalThis.claude && globalThis.claude.web);
  const localSessions = root && root.LocalSessions;
  const localAgentModeSessions = root && root.LocalAgentModeSessions;
  return {
    ok: Boolean(root),
    href: globalThis.location && globalThis.location.href,
    title: globalThis.document && globalThis.document.title,
    rootKeys: root ? Object.keys(root).sort() : [],
    apis: {
      LocalSessions: localSessions ? Object.keys(localSessions).sort() : [],
      LocalAgentModeSessions: localAgentModeSessions ? Object.keys(localAgentModeSessions).sort() : []
    }
  };
})()`;
}

function rendererCallExpression(payload) {
  return `(async () => {
  const payload = ${JSON.stringify(payload)};
  const root = globalThis["claude.web"] || (globalThis.claude && globalThis.claude.web);
  const api = root && root[payload.apiName];
  const toPlain = (value) => {
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return String(value); }
  };
  if (!root) {
    return { ok: false, error: "claude.web root not found" };
  }
  if (!api) {
    return { ok: false, error: payload.apiName + " not found", rootKeys: Object.keys(root).sort() };
  }
  const requireMethod = (name) => {
    if (typeof api[name] !== "function") throw new Error(payload.apiName + "." + name + " is not a function");
    return api[name].bind(api);
  };
  try {
    if (payload.action === "start") {
      const start = requireMethod("start");
      const startResult = await start(payload.startPayload);
      const sessionId = payload.sessionId || (startResult && (startResult.sessionId || startResult.id));
      const forceResults = [];
      for (const op of payload.forceOps || []) {
        const fn = requireMethod(op.method);
        forceResults.push({ method: op.method, result: toPlain(await fn(...op.args)) });
      }
      let sendResult = null;
      if (payload.promptAfterStart) {
        const sendMessage = requireMethod("sendMessage");
        sendResult = await sendMessage(...payload.sendArgs);
      }
      return { ok: true, sessionId, startResult: toPlain(startResult), forceResults, sendResult: toPlain(sendResult) };
    }

    if (payload.action === "send") {
      const forceResults = [];
      for (const op of payload.forceOps || []) {
        const fn = requireMethod(op.method);
        forceResults.push({ method: op.method, result: toPlain(await fn(...op.args)) });
      }
      const sendMessage = requireMethod("sendMessage");
      const sendResult = await sendMessage(...payload.sendArgs);
      return { ok: true, sessionId: payload.sessionId, forceResults, sendResult: toPlain(sendResult) };
    }

    if (payload.action === "getTranscript") {
      const getTranscript = requireMethod("getTranscript");
      return { ok: true, sessionId: payload.sessionId, transcript: toPlain(await getTranscript(payload.sessionId, payload.options || {})) };
    }

    if (payload.action === "getAll") {
      const getAll = requireMethod("getAll");
      return { ok: true, sessions: toPlain(await getAll()) };
    }

    return { ok: false, error: "unknown renderer action: " + payload.action };
  } catch (error) {
    return { ok: false, error: String(error && (error.stack || error.message) || error) };
  }
})()`;
}

async function createRendererClient(args, surface = "code") {
  const timeoutMs = toInt(args["bridge-timeout-ms"], DEFAULT_BRIDGE_TIMEOUT_MS);
  const mainCandidates = inspectorCandidates(args);
  const cdpOnlyCandidates = cdpCandidates(args);
  const attempts = [];
  const expectedSuffixes = expectedEipcSuffixes(surface);

  for (const candidate of mainCandidates) {
    try {
      const resolved = await resolveInspectorWsUrl(candidate, timeoutMs);
      const probe = await inspectorEvalInMain(
        resolved.wsUrl,
        mainEvaluateRendererBody(rendererProbeExpression()),
        timeoutMs,
      );
      const registry = await inspectorEvalInMain(
        resolved.wsUrl,
        eipcRegistryProbeBody(expectedSuffixes),
        timeoutMs,
      );
      attempts.push({ candidate, ok: Boolean(probe?.ok), probe, registry });
      if (probe?.ok) {
        const apiName = apiNameForSurface(surface);
        if (!probe.apis?.[apiName]?.length) {
          attempts[attempts.length - 1].error = `${apiName} not exposed`;
          continue;
        }
        return {
          available: true,
          transport: {
            kind: candidate.kind,
            url: candidate.url,
            source: candidate.source,
            target: resolved.target
              ? { id: resolved.target.id, type: resolved.target.type, title: resolved.target.title, url: resolved.target.url }
              : null,
          },
          probe,
          registry,
          attempts,
          evaluate: (expression) =>
            inspectorEvalInMain(resolved.wsUrl, mainEvaluateRendererBody(expression), timeoutMs),
        };
      }
    } catch (error) {
      attempts.push({ candidate, ok: false, error: String(error.message || error) });
    }
  }

  for (const candidate of cdpOnlyCandidates) {
    try {
      const resolved = await resolveCdpWsUrl(candidate, timeoutMs);
      const probe = await cdpEvaluate(resolved.wsUrl, rendererProbeExpression(), timeoutMs);
      attempts.push({ candidate, ok: Boolean(probe?.ok), probe });
      if (probe?.ok) {
        const apiName = apiNameForSurface(surface);
        if (!probe.apis?.[apiName]?.length) {
          attempts[attempts.length - 1].error = `${apiName} not exposed`;
          continue;
        }
        return {
          available: true,
          transport: {
            kind: candidate.kind,
            url: candidate.url,
            source: candidate.source,
            target: resolved.target
              ? { id: resolved.target.id, type: resolved.target.type, title: resolved.target.title, url: resolved.target.url }
              : null,
          },
          probe,
          registry: null,
          attempts,
          evaluate: (expression) => cdpEvaluate(resolved.wsUrl, expression, timeoutMs),
        };
      }
    } catch (error) {
      attempts.push({ candidate, ok: false, error: String(error.message || error) });
    }
  }

  return {
    available: false,
    reason:
      mainCandidates.length || cdpOnlyCandidates.length
        ? "claude.web renderer API not observed"
        : "no existing renderer eval transport found",
    attempts,
  };
}

function requiredRawIpcSuffixes(surface) {
  const apiName = apiNameForSurface(surface);
  const requiredMethods =
    surface === "cowork"
      ? ["start", "sendMessage", "setModel", "setEffort"]
      : ["start", "sendMessage", "setModel", "setEffort", "applyFlagSettings"];
  return requiredMethods.map((method) => `${apiName}_$_${method}`);
}

function rawIpcInvokeBody(call, urlFilters = ["claude.ai", "claude.com", "localhost"]) {
  return `
    const call = ${JSON.stringify(call)};
    const filters = ${JSON.stringify(urlFilters)};
    const toPlain = (value) => {
      try { return JSON.parse(JSON.stringify(value)); }
      catch { return String(value); }
    };
    const loadElectron = () => {
      if (typeof require === 'function') return require('electron');
      if (process.mainModule && typeof process.mainModule.require === 'function') {
        return process.mainModule.require('electron');
      }
      if (typeof globalThis.__non_webpack_require__ === 'function') {
        return globalThis.__non_webpack_require__('electron');
      }
      throw new Error('electron require unavailable in main inspector');
    };
    const { webContents } = loadElectron();
    const framed = /^\\$eipc_message\\$_[0-9a-f-]+_\\$_(.+)$/;
    const all = webContents.getAllWebContents().filter((wc) => !(wc.isDestroyed && wc.isDestroyed()));
    const summaries = [];
    let selected = null;

    const mapKeys = (map) => {
      if (!map) return [];
      if (typeof map.keys === 'function') return Array.from(map.keys());
      return Object.keys(map);
    };
    const mapGet = (map, key) => {
      if (!map) return undefined;
      if (typeof map.get === 'function') return map.get(key);
      return map[key];
    };

    for (const wc of all) {
      const url = wc.getURL();
      const ipc = wc.ipc;
      const map = ipc && ipc._invokeHandlers;
      const keys = mapKeys(map);
      const matchingKeys = keys.filter((key) => key.endsWith(call.suffix));
      const inFilteredRenderer = filters.length === 0 || filters.some((filter) => url.includes(filter));
      summaries.push({
        id: wc.id,
        url,
        type: wc.getType ? wc.getType() : 'unknown',
        totalHandlers: keys.length,
        matchingKeys,
        filtered: inFilteredRenderer,
      });
      if (matchingKeys.length && (!selected || inFilteredRenderer)) {
        selected = { wc, map, key: matchingKeys[0], url, inFilteredRenderer };
        if (inFilteredRenderer) break;
      }
    }

    if (!selected) {
      return { ok: false, error: 'eIPC handler not found for suffix: ' + call.suffix, webContents: summaries };
    }

    const handler = mapGet(selected.map, selected.key);
    if (typeof handler !== 'function') {
      return { ok: false, error: 'registered eIPC handler is not a function: ' + selected.key, webContents: summaries };
    }

    const frame = selected.wc.mainFrame || null;
    const fallbackFrame = {
      url: selected.url,
      top: null,
      parent: null,
      routingId: 0,
      processId: selected.wc.getOSProcessId ? selected.wc.getOSProcessId() : 0,
    };
    const senderFrame = frame || fallbackFrame;
    const event = {
      sender: selected.wc,
      senderFrame,
      frameId: senderFrame.routingId || 0,
      processId: senderFrame.processId || (selected.wc.getOSProcessId ? selected.wc.getOSProcessId() : 0),
    };

    try {
      const result = await handler(event, ...(call.args || []));
      const suffix = (framed.exec(selected.key) || [null, selected.key])[1];
      return {
        ok: true,
        suffix,
        fullKey: selected.key,
        webContentsId: selected.wc.id,
        url: selected.url,
        result: toPlain(result),
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error && (error.stack || error.message) || error),
        fullKey: selected.key,
        webContentsId: selected.wc.id,
        url: selected.url,
      };
    }
  `;
}

async function createMainInspectorClient(args, surface = "code") {
  const timeoutMs = toInt(args["bridge-timeout-ms"], DEFAULT_BRIDGE_TIMEOUT_MS);
  const attempts = [];
  const expectedSuffixes = expectedEipcSuffixes(surface);
  const requiredSuffixes = requiredRawIpcSuffixes(surface);
  let reachable = null;

  for (const candidate of inspectorCandidates(args)) {
    try {
      const resolved = await resolveInspectorWsUrl(candidate, timeoutMs);
      const registry = await inspectorEvalInMain(
        resolved.wsUrl,
        eipcRegistryProbeBody(expectedSuffixes),
        timeoutMs,
      );
      const missingRequired = requiredSuffixes.filter((suffix) => !registry?.expected?.[suffix]?.present);
      const client = {
        available: missingRequired.length === 0,
        inspectorAvailable: true,
        reason: missingRequired.length ? `missing required eIPC handlers: ${missingRequired.join(", ")}` : null,
        missingRequired,
        transport: {
          kind: "main-inspector-raw-ipc",
          url: candidate.url,
          source: candidate.source,
          target: resolved.target
            ? { id: resolved.target.id, type: resolved.target.type, title: resolved.target.title, url: resolved.target.url }
            : null,
        },
        registry,
        attempts: [...attempts, { candidate, ok: missingRequired.length === 0, registry }],
        evaluate: (body) => inspectorEvalInMain(resolved.wsUrl, body, timeoutMs),
        invoke: (suffix, callArgs) =>
          inspectorEvalInMain(
            resolved.wsUrl,
            rawIpcInvokeBody({ suffix, args: callArgs || [] }),
            timeoutMs,
          ),
      };
      attempts.push({ candidate, ok: client.available, registry });
      if (client.available) return client;
      reachable = client;
    } catch (error) {
      attempts.push({ candidate, ok: false, error: String(error.message || error) });
    }
  }

  if (reachable) {
    return { ...reachable, attempts };
  }

  return {
    available: false,
    inspectorAvailable: false,
    reason: "no existing main-process inspector transport found",
    attempts,
  };
}

function mainInspectPort(args) {
  return toInt(
    args["main-inspect-port"] ||
      args.mainInspectPort ||
      args["inspect-port"] ||
      process.env.CLAUDE_MAIN_INSPECT_PORT,
    DEFAULT_MAIN_INSPECT_PORT,
  );
}

async function waitForRendererClient(args, surface, timeoutMs = 15000) {
  return waitForCondition(async () => {
    const client = await createRendererClient(args, surface);
    return client.available ? client : null;
  }, timeoutMs, 750);
}

async function waitForMainInspectorClient(args, surface, timeoutMs = 15000) {
  return waitForCondition(async () => {
    const client = await createMainInspectorClient(args, surface);
    return client.available ? client : null;
  }, timeoutMs, 750);
}

async function bootstrapRawIpcBridge(args, surface, options = {}) {
  const steps = [];
  const port = mainInspectPort(args);
  const withPortArgs = { ...args, "main-inspect-port": String(port) };
  const initial = await createMainInspectorClient(withPortArgs, surface);
  if (initial.available) {
    return { ok: true, client: initial, steps: [{ action: "probe", ok: true }], port };
  }
  steps.push({
    action: "probe",
    ok: false,
    reason: initial.reason,
    inspectorAvailable: Boolean(initial.inspectorAvailable),
    attempts: initial.attempts,
  });

  if (initial.inspectorAvailable) {
    return {
      ok: false,
      client: initial,
      port,
      steps,
      reason: initial.reason || "main inspector is reachable, but required LocalSessions handlers are not registered",
    };
  }

  const mainProcesses = listClaudeDesktopMainProcesses();
  const mainProcess = mainProcesses[0] || null;

  if (mainProcess && process.platform === "win32") {
    const attach = tryDebugExistingMainProcess(mainProcess);
    steps.push({ action: "windows-process-debug-attach", ...attach });
    const attachedClient = await waitForMainInspectorClient(withPortArgs, surface, 5000);
    if (attachedClient?.available) {
      return { ok: true, client: attachedClient, steps, port };
    }
  }

  if (mainProcess && !toBool(args["attach-only"])) {
    try {
      const launch = launchClaudeDesktopWithInspector(port);
      steps.push({ action: "second-instance-inspect-launch", ok: true, ...launch });
      const secondInstanceClient = await waitForMainInspectorClient(withPortArgs, surface, 7000);
      if (secondInstanceClient?.available) {
        return { ok: true, client: secondInstanceClient, steps, port };
      }
    } catch (error) {
      steps.push({ action: "second-instance-inspect-launch", ok: false, reason: String(error.message || error) });
    }
  } else if (!mainProcess && !toBool(args["attach-only"])) {
    try {
      const launch = launchClaudeDesktopWithInspector(port);
      steps.push({ action: "launch-with-main-inspector", ok: true, ...launch });
      const launchedClient = await waitForMainInspectorClient(withPortArgs, surface, 20000);
      if (launchedClient?.available) {
        return { ok: true, client: launchedClient, steps, port };
      }
    } catch (error) {
      steps.push({ action: "launch-with-main-inspector", ok: false, reason: String(error.message || error) });
    }
  }

  const restartRequested =
    options.forceRestart ||
    toBool(args["restart-claude"]) ||
    toBool(args.restartClaude) ||
    process.env.CLAUDE_BRIDGE_RESTART === "1";
  if (restartRequested) {
    if (!toBool(args.yes) && process.env.CLAUDE_BRIDGE_RESTART_YES !== "1") {
      return {
        ok: false,
        port,
        steps,
        reason: "restart requested but --yes was not provided",
      };
    }
    try {
      const stopped = stopClaudeDesktopProcesses();
      steps.push({ action: "stop-claude-desktop", ok: true, ...stopped });
      await waitForCondition(() => listClaudeDesktopProcesses().length === 0, 10000, 500);
      const launch = launchClaudeDesktopWithInspector(port);
      steps.push({ action: "restart-with-main-inspector", ok: true, ...launch });
      const restartedClient = await waitForMainInspectorClient(withPortArgs, surface, 30000);
      if (restartedClient?.available) {
        return { ok: true, client: restartedClient, steps, port };
      }
    } catch (error) {
      steps.push({ action: "restart-with-main-inspector", ok: false, reason: String(error.message || error) });
    }
  }

  return {
    ok: false,
    client: initial,
    port,
    steps,
    reason: mainProcess
      ? "Claude Desktop is running without an attachable raw eIPC bridge; try enabling the app main-process debugger without closing Claude, then run raw probe again"
      : "Claude Desktop could not be launched with an attachable raw eIPC bridge",
  };
}

async function bootstrapRendererBridge(args, surface, options = {}) {
  const steps = [];
  const port = mainInspectPort(args);
  const withPortArgs = { ...args, "main-inspect-port": String(port) };
  const initial = await createRendererClient(withPortArgs, surface);
  if (initial.available) {
    return { ok: true, client: initial, steps: [{ action: "probe", ok: true }], port };
  }
  steps.push({ action: "probe", ok: false, reason: initial.reason, attempts: initial.attempts });

  const mainProcesses = listClaudeDesktopMainProcesses();
  const mainProcess = mainProcesses[0] || null;

  if (mainProcess && process.platform === "win32") {
    const attach = tryDebugExistingMainProcess(mainProcess);
    steps.push({ action: "windows-process-debug-attach", ...attach });
    const attachedClient = await waitForRendererClient(withPortArgs, surface, 5000);
    if (attachedClient?.available) {
      return { ok: true, client: attachedClient, steps, port };
    }
  }

  if (mainProcess && !toBool(args["attach-only"])) {
    try {
      const launch = launchClaudeDesktopWithInspector(port);
      steps.push({ action: "second-instance-inspect-launch", ok: true, ...launch });
      const secondInstanceClient = await waitForRendererClient(withPortArgs, surface, 7000);
      if (secondInstanceClient?.available) {
        return { ok: true, client: secondInstanceClient, steps, port };
      }
    } catch (error) {
      steps.push({ action: "second-instance-inspect-launch", ok: false, reason: String(error.message || error) });
    }
  } else if (!mainProcess && !toBool(args["attach-only"])) {
    try {
      const launch = launchClaudeDesktopWithInspector(port);
      steps.push({ action: "launch-with-main-inspector", ok: true, ...launch });
      const launchedClient = await waitForRendererClient(withPortArgs, surface, 20000);
      if (launchedClient?.available) {
        return { ok: true, client: launchedClient, steps, port };
      }
    } catch (error) {
      steps.push({ action: "launch-with-main-inspector", ok: false, reason: String(error.message || error) });
    }
  }

  const restartRequested =
    options.forceRestart ||
    toBool(args["restart-claude"]) ||
    toBool(args.restartClaude) ||
    process.env.CLAUDE_BRIDGE_RESTART === "1";
  if (restartRequested) {
    if (!toBool(args.yes) && process.env.CLAUDE_BRIDGE_RESTART_YES !== "1") {
      return {
        ok: false,
        port,
        steps,
        reason: "restart requested but --yes was not provided",
      };
    }
    try {
      const stopped = stopClaudeDesktopProcesses();
      steps.push({ action: "stop-claude-desktop", ok: true, ...stopped });
      await waitForCondition(() => listClaudeDesktopProcesses().length === 0, 10000, 500);
      const launch = launchClaudeDesktopWithInspector(port);
      steps.push({ action: "restart-with-main-inspector", ok: true, ...launch });
      const restartedClient = await waitForRendererClient(withPortArgs, surface, 30000);
      if (restartedClient?.available) {
        return { ok: true, client: restartedClient, steps, port };
      }
    } catch (error) {
      steps.push({ action: "restart-with-main-inspector", ok: false, reason: String(error.message || error) });
    }
  }

  return {
    ok: false,
    port,
    steps,
    reason: mainProcess
      ? "Claude Desktop is running without an attachable renderer bridge; use bridge restart --yes or --restart-claude --yes"
      : "Claude Desktop could not be launched with an attachable renderer bridge",
  };
}

async function requireRendererClient(args, surface) {
  const client = await createRendererClient(args, surface);
  if (client.available) return client;

  if (!toBool(args["no-bootstrap"])) {
    const boot = await bootstrapRendererBridge(args, surface);
    if (boot.ok && boot.client?.available) {
      return boot.client;
    }
    throw new CliError(
      "renderer bridge unavailable after bootstrap; refusing to start/send without claude.web LocalSessions API",
      2,
      { initial: client, bootstrap: boot },
    );
  }

  throw new CliError(
    "renderer bridge unavailable; refusing to start/send without claude.web LocalSessions API",
    2,
    client,
  );
}

async function requireMainInspectorClient(args, surface) {
  const client = await createMainInspectorClient(args, surface);
  if (client.available) return client;

  if (!toBool(args["no-bootstrap"])) {
    const boot = await bootstrapRawIpcBridge(args, surface);
    if (boot.ok && boot.client?.available) {
      return boot.client;
    }
    throw new CliError(
      "raw eIPC bridge unavailable after bootstrap; refusing to start/send without LocalSessions handlers",
      2,
      { initial: client, bootstrap: boot },
    );
  }

  throw new CliError(
    "raw eIPC bridge unavailable; refusing to start/send without LocalSessions handlers",
    2,
    client,
  );
}

async function rendererAction(args, surface, payload) {
  const client = await requireRendererClient(args, surface);
  const result = await client.evaluate(rendererCallExpression(payload));
  if (!result?.ok) {
    throw new CliError(result?.error || "renderer action failed", 2, { bridge: client, result });
  }
  return { bridge: client, result };
}

async function checkedRawInvoke(client, suffix, callArgs) {
  const result = await client.invoke(suffix, callArgs);
  if (!result?.ok) {
    throw new CliError(result?.error || `raw eIPC call failed: ${suffix}`, 2, {
      bridge: client.transport,
      suffix,
      result,
    });
  }
  return result;
}

async function rawIpcAction(args, surface, payload) {
  const client = await requireMainInspectorClient(args, surface);
  const apiName = apiNameForSurface(surface);
  const suffixFor = (method) => `${apiName}_$_${method}`;
  const rawCalls = [];

  if (payload.action === "start") {
    const startCall = await checkedRawInvoke(client, suffixFor("start"), [payload.startPayload]);
    rawCalls.push({ method: "start", fullKey: startCall.fullKey, webContentsId: startCall.webContentsId });
    const sessionId = payload.sessionId || startCall.result?.sessionId || startCall.result?.id;
    const forceResults = [];
    for (const op of payload.forceOps || []) {
      const forceCall = await checkedRawInvoke(client, suffixFor(op.method), op.args);
      forceResults.push({ method: op.method, result: forceCall.result });
      rawCalls.push({ method: op.method, fullKey: forceCall.fullKey, webContentsId: forceCall.webContentsId });
    }

    let sendResult = null;
    if (payload.promptAfterStart) {
      const sendCall = await checkedRawInvoke(client, suffixFor("sendMessage"), payload.sendArgs);
      sendResult = sendCall.result;
      rawCalls.push({ method: "sendMessage", fullKey: sendCall.fullKey, webContentsId: sendCall.webContentsId });
    }

    return {
      bridge: client,
      result: {
        ok: true,
        sessionId,
        startResult: startCall.result,
        forceResults,
        sendResult,
        rawCalls,
      },
    };
  }

  if (payload.action === "send") {
    const forceResults = [];
    for (const op of payload.forceOps || []) {
      const forceCall = await checkedRawInvoke(client, suffixFor(op.method), op.args);
      forceResults.push({ method: op.method, result: forceCall.result });
      rawCalls.push({ method: op.method, fullKey: forceCall.fullKey, webContentsId: forceCall.webContentsId });
    }
    const sendCall = await checkedRawInvoke(client, suffixFor("sendMessage"), payload.sendArgs);
    rawCalls.push({ method: "sendMessage", fullKey: sendCall.fullKey, webContentsId: sendCall.webContentsId });
    return {
      bridge: client,
      result: {
        ok: true,
        sessionId: payload.sessionId,
        forceResults,
        sendResult: sendCall.result,
        rawCalls,
      },
    };
  }

  if (payload.action === "getTranscript") {
    const transcriptCall = await checkedRawInvoke(client, suffixFor("getTranscript"), [
      payload.sessionId,
      payload.options || {},
    ]);
    return {
      bridge: client,
      result: {
        ok: true,
        sessionId: payload.sessionId,
        transcript: transcriptCall.result,
        rawCalls: [{ method: "getTranscript", fullKey: transcriptCall.fullKey, webContentsId: transcriptCall.webContentsId }],
      },
    };
  }

  if (payload.action === "getAll") {
    const allCall = await checkedRawInvoke(client, suffixFor("getAll"), []);
    return {
      bridge: client,
      result: {
        ok: true,
        sessions: allCall.result,
        rawCalls: [{ method: "getAll", fullKey: allCall.fullKey, webContentsId: allCall.webContentsId }],
      },
    };
  }

  throw new CliError(`unknown raw eIPC action: ${payload.action}`, 2);
}

function sendTransportMode(args) {
  if (toBool(args["raw-ipc"]) || toBool(args.rawIpc)) return "raw";
  if (toBool(args.cli) || toBool(args["cli-resume"]) || toBool(args.cliResume)) return "cli";
  const requested = String(args.transport || args.via || "auto").toLowerCase();
  if (requested === "raw-ipc") return "raw";
  if (requested === "claude-code" || requested === "claude-code-cli" || requested === "cli-resume") return "cli";
  if (requested === "live" || requested === "stdin" || requested === "live-stdin") return "live-stdin";
  if (["auto", "renderer", "raw", "peer", "live-stdin", "cli"].includes(requested)) return requested;
  throw new CliError(`unknown transport: ${requested}`);
}

function cliFallbackAllowed(args) {
  return (
    toBool(args["allow-cli-fallback"]) ||
    toBool(args.allowCliFallback) ||
    process.env.CLAUDE_BRIDGE_ALLOW_CLI_FALLBACK === "1"
  );
}

async function chooseSendTransport(args, surface, session = null) {
  const requested = sendTransportMode(args);
  if (requested !== "auto") return requested;

  const probeArgs = { ...args, "no-bootstrap": true };
  const renderer = await createRendererClient(probeArgs, surface);
  if (renderer.available) return "renderer";

  const raw = await createMainInspectorClient(probeArgs, surface);
  if (raw.available) return "raw";

  // Peer inputs are meta messages and can be hidden by Desktop. Ordinary sends
  // use the app-owned stream-json input and its replayed visible user row.
  const visible = chooseDesktopSendTransport(surface);
  if (visible) return visible;

  if (surface === "code" && session) {
    try { findPeerRuntime(session, listClaudeCodeCliProcesses()); return "peer"; } catch { /* Continue only to ID-bound transports. */ }
  }
  if (surface === "code" && session && findLiveClaudeCodeProcessForSession(session)) return "live-stdin";

  if (surface === "code") {
    if (cliFallbackAllowed(args)) return "cli";
    throw new CliError("No app-owned Claude Desktop transport is available; CLI fallback is disabled by default. Pass --allow-cli-fallback only when the user explicitly approves CLI resume.");
  }
  return "renderer";
}

function claudeCodeCliArgs(session, prompt) {
  if (!session.cliSessionId) {
    throw new CliError(`Code session has no cliSessionId: ${session.sessionId}`);
  }
  return [
    "--print",
    "--output-format",
    "json",
    "--resume",
    session.cliSessionId,
    "--model",
    CODE_MODEL,
    "--effort",
    CODE_EFFORT,
    "--permission-mode",
    DEFAULT_PERMISSION_MODE,
    "--allow-dangerously-skip-permissions",
    "--setting-sources=user,project,local",
    "--settings",
    JSON.stringify({ ultracode: true }),
    prompt,
  ];
}

function parseClaudeCodeJsonOutput(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

function runClaudeCodeCliForeground(executablePath, cliArgs, options) {
  const timeoutMs = toInt(options.timeoutMs, DEFAULT_CLI_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executablePath, cliArgs, {
      cwd: options.cwd,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore kill errors
      }
      reject(
        new CliError("Claude Code CLI timed out while waiting for a response", 3, {
          timeoutMs,
          stdout: stdout.slice(-2000),
          stderr: stderr.slice(-2000),
        }),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const parsed = parseClaudeCodeJsonOutput(stdout);
      if (code !== 0 || parsed?.is_error) {
        reject(
          new CliError(parsed?.result || stderr.trim() || `Claude Code CLI exited with code ${code}`, code || 2, {
            code,
            signal,
            stdout: parsed || stdout,
            stderr,
          }),
        );
        return;
      }
      resolve({ code, signal, stdout: parsed || stdout, stderr });
    });
  });
}

function spawnClaudeCodeCliBackground(executablePath, cliArgs, cwd) {
  const child = spawn(executablePath, cliArgs, {
    cwd,
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid };
}

async function waitForTranscriptText(surface, args, text, baselineFingerprint, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const transcript = readLocalTranscript(surface, args);
      const fingerprint = transcriptFingerprint(transcript.entries);
      if (
        fingerprint !== baselineFingerprint &&
        transcript.entries.some((entry) => entry.text.includes(text))
      ) {
        return transcript;
      }
    } catch {
      // The resumed CLI may create or move transcript files just after launch.
    }
    await sleep(500);
  }
  return null;
}

async function codeCliResumeAction(args, surface, session, prompt, baselineFingerprint) {
  if (surface !== "code") {
    throw new CliError("Claude Code CLI resume transport only supports Code sessions");
  }
  const executablePath = args["claude-code-exe"] || args.claudeCodeExe || findClaudeCodeExecutable();
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new CliError("Claude Code executable not found");
  }
  const authSync = syncClaudeCodeCredentialsFromDesktop(args);
  const cwd = session.cwd || resolveCwd(args.cwd);
  const cliArgs = claudeCodeCliArgs(session, prompt);
  const transport = {
    kind: "claude-code-cli-resume",
    executablePath,
    cliSessionId: session.cliSessionId,
    authSync: {
      ok: authSync.ok,
      skipped: authSync.skipped,
      changed: authSync.changed || false,
      credentialsPath: authSync.credentialsPath || null,
      backupPath: authSync.backupPath || null,
      expiresAt: authSync.expiresAt || null,
      scopes: authSync.scopes || null,
    },
  };

  if (toBool(args.wait) || toBool(args.foreground)) {
    const result = await runClaudeCodeCliForeground(executablePath, cliArgs, {
      cwd,
      timeoutMs: args["cli-timeout-ms"] || args.cliTimeoutMs || args["timeout-ms"],
    });
    return {
      bridge: { transport },
      result: {
        ok: true,
        mode: "foreground",
        cli: result.stdout,
        stderr: result.stderr,
      },
    };
  }

  const spawned = spawnClaudeCodeCliBackground(executablePath, cliArgs, cwd);
  const shouldConfirmSend = toBool(args["confirm-send"]) || toBool(args.confirmSend);
  const observedTranscript = shouldConfirmSend
    ? await waitForTranscriptText(
        surface,
        { ...args, "session-id": session.sessionId },
        prompt,
        baselineFingerprint,
        toInt(args["send-observe-timeout-ms"] || args.sendObserveTimeoutMs, DEFAULT_SEND_OBSERVE_TIMEOUT_MS),
      )
    : null;
  return {
    bridge: { transport },
    result: {
      ok: true,
      mode: "background",
      pid: spawned.pid,
      userMessageObserved: shouldConfirmSend ? Boolean(observedTranscript) : null,
      transcriptSource: observedTranscript?.source || null,
    },
  };
}

function claudeCodeStreamJsonUserFrame(prompt) {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
  });
}

function runLiveStdinHelper(parentPid, childPid, jsonLine, { dryRun = false } = {}) {
  if (process.platform !== "win32") {
    throw new CliError("live-stdin transport is only supported on Windows");
  }
  if (!fs.existsSync(liveStdinHelperPath)) {
    throw new CliError(`live-stdin helper not found: ${liveStdinHelperPath}`);
  }

  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      liveStdinHelperPath,
      "-ParentPid",
      String(parentPid),
      "-ChildPid",
      String(childPid),
      ...(dryRun ? ["-DryRun"] : ["-StdinBase64"]),
    ],
    {
      encoding: "utf8",
      input: dryRun ? "" : Buffer.from(jsonLine, "utf8").toString("base64"),
      timeout: 15000,
      windowsHide: true,
    },
  ).trim();

  try {
    return JSON.parse(output);
  } catch {
    throw new CliError("live-stdin helper returned non-JSON output", 2, { output });
  }
}

function resolveLiveCodeProcess(session) {
  const processes = listClaudeCodeCliProcesses();
  let liveProcess = findLiveClaudeCodeProcessForSession(session, processes);
  if (!liveProcess) {
    // Newly initialized Desktop children receive their session through stdin,
    // so --resume/--session-id need not appear on the process command line.
    // Resolve them only through the exact registry identity and a live PID/start
    // probe; never infer identity from creation time, model, or focus.
    try {
      const runtime = findPeerRuntime(session, processes);
      liveProcess = runtimeVerifiedStdinProcess(session, processes, runtime, probePeer(runtime));
    } catch {
      liveProcess = null;
    }
  }
  if (!liveProcess) {
    throw new CliError(`No running Claude Desktop claude-code child found for cliSessionId ${session.cliSessionId}`);
  }
  const childPid = Number(liveProcess.ProcessId || liveProcess.processId || 0);
  const parentPid = findDesktopParentPidForCodeProcess(liveProcess);
  if (!childPid || !parentPid) {
    throw new CliError("Could not resolve live Claude Desktop parent/child PIDs", 2, { liveProcess });
  }
  return { liveProcess, childPid, parentPid };
}

function runtimeVerifiedStdinProcess(session, processes, runtime, probe) {
  if (!runtime || !probe || probe.ok !== true || probe.probe !== true ||
      runtime.sessionId !== session.cliSessionId || probe.sessionId !== session.cliSessionId ||
      probe.serverPid !== runtime.pid || probe.procStart !== runtime.procStart ||
      !runtime.cwd || !session.cwd ||
      path.win32.resolve(runtime.cwd).toLowerCase() !== path.win32.resolve(session.cwd).toLowerCase()) return null;
  const matches = processes.filter((proc) => Number(proc.ProcessId || proc.processId) === runtime.pid);
  if (matches.length !== 1) return null;
  const commandLine = lower(matches[0].CommandLine || matches[0].commandLine);
  if (/(?:^|\s)--(?:resume|session-id)(?:=|\s+)/.test(commandLine) ||
      !/(?:^|\s)--input-format(?:=|\s+)stream-json(?:\s|$)/.test(commandLine) ||
      !/(?:^|\s)--output-format(?:=|\s+)stream-json(?:\s|$)/.test(commandLine)) return null;
  return matches[0];
}

const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

function buildPermissionModeControlFrame(mode, requestId = crypto.randomUUID()) {
  if (!CLAUDE_PERMISSION_MODES.includes(mode)) {
    throw new CliError(`--mode must be one of ${CLAUDE_PERMISSION_MODES.join(", ")}`);
  }
  // Same control request the Claude Agent SDK sends for query.setPermissionMode().
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "set_permission_mode", mode } });
}

function permissionModeLaunchBlocker(commandLine, mode) {
  if (mode !== "bypassPermissions") return null;
  // Claude Code only accepts a runtime switch to bypass when the process was launched with one of these flags.
  if (/(?:^|\s)--(?:allow-)?dangerously-skip-permissions(?:\s|$)/.test(String(commandLine || ""))) return null;
  return "This Claude Code process was not launched with --allow-dangerously-skip-permissions, so it would reject bypassPermissions.";
}

async function cmdSetPermissionMode(args, surface) {
  if (surface !== "code" || !(args["session-id"] || args.sessionId)) {
    throw new CliError("code set-permission-mode requires an explicit --session-id");
  }
  const mode = String(args.mode || "");
  buildPermissionModeControlFrame(mode);
  const session = resolveSession(surface, args);
  const dryRun = toBool(args["dry-run"]);
  if (!dryRun) await wakeCodeSession(session, toInt(args['wake-timeout-ms'], 30000));
  const { requestId, parentPid, childPid, helper } = applyRuntimePermissionMode(session, mode, { dryRun });
  const recorded = dryRun ? null : await waitForCondition(() => {
    const current = findImportedSession(listSessions('code'), session.cliSessionId);
    return current?.permissionMode === mode ? current : null;
  }, toInt(args['timeout-ms'], 30000)).catch(() => null);
  if (!dryRun && !recorded) throw new CliError('Permission request was written but Desktop mode readback did not match', 2,
    { sessionId: session.sessionId, requestId, mode, delivery: 'written-unconfirmed' });
  printJson({
    ok: true,
    dryRun,
    sessionId: session.sessionId,
    cliSessionId: session.cliSessionId,
    mode,
    requestId,
    parentPid,
    childPid,
    helper,
    desktopRecordedMode: recorded?.permissionMode || null,
    delivery: dryRun ? 'dry-run' : 'desktop-confirmed',
  });
}

async function codeLiveStdinAction(args, surface, session, prompt) {
  if (surface !== "code") {
    throw new CliError("live-stdin transport only supports Code sessions");
  }
  if (!session.cliSessionId) {
    throw new CliError(`Code session has no cliSessionId: ${session.sessionId}`);
  }

  await wakeCodeSession(session, toInt(args['wake-timeout-ms'], 30000));
  const { liveProcess, childPid, parentPid } = resolveLiveCodeProcess(session);
  if (!/(?:^|\s)--replay-user-messages(?:\s|$)/.test(liveProcess.CommandLine || liveProcess.commandLine || ''))
    throw new CliError('The app-owned child does not replay visible user messages; no prompt was sent', 2, { delivery: 'not-sent', sessionId: session.sessionId });
  const runtime = { sessionId: session.cliSessionId };
  const reservation = await reservePeerMessage(runtime, prompt);
  const transcriptPath = codeTranscriptPath(session);
  const offset = fs.existsSync(transcriptPath) ? fs.statSync(transcriptPath).size : 0;
  const frame = buildVisibleUserFrame(session.cliSessionId, prompt, reservation.messageId);
  let helper;
  try { helper = runLiveStdinHelper(parentPid, childPid, frame); }
  catch (error) {
    await markPeerMessage(reservation.recordPath, reservation.messageId, 'unknown');
    throw new CliError('Visible input acknowledgement lost; read the exact session before retrying', 2,
      { delivery: 'unknown', messageId: reservation.messageId, sessionId: session.cliSessionId, error: error.message });
  }
  if (!helper.ok) {
    await markPeerMessage(reservation.recordPath, reservation.messageId, 'unknown');
    throw new CliError("live-stdin helper failed to write to Claude Code stdin", 2, { ...helper, delivery: 'unknown', messageId: reservation.messageId });
  }
  await markPeerMessage(reservation.recordPath, reservation.messageId, 'written-unconfirmed');
  let receipt;
  if (toBool(args.wait)) {
    try {
      receipt = await waitForPeerReceipt(transcriptPath, runtime, reservation.messageId, toInt(args['timeout-ms'], DEFAULT_WAIT_TIMEOUT_MS), offset);
      await markPeerMessage(reservation.recordPath, reservation.messageId, 'confirmed');
    } catch (error) {
      await markPeerMessage(reservation.recordPath, reservation.messageId, error.details?.delivery || 'unknown');
      throw error;
    }
  }

  return {
    bridge: {
      transport: {
        kind: "claude-desktop-live-stdin",
        parentPid,
        childPid,
        cliSessionId: session.cliSessionId,
        target: helper.target || null,
      },
    },
    result: {
      ok: true,
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      helper,
      messageId: reservation.messageId,
      outboxPath: reservation.recordPath,
      visibility: 'ordinary-user-message',
      delivery: receipt ? 'transcript-confirmed' : 'written-unconfirmed',
      ...(receipt || {}),
    },
  };
}

function peerPermissionHoldRisk(senderMode, receiverMode) {
  // Claude holds a cross-session message for its user's approval when the sender declares
  // bypass but the receiving session runs in another mode. Such a message never reaches the
  // transcript on its own, which looks like a missing session from the sender's side.
  if (senderMode !== "bypass" || !receiverMode || receiverMode === "bypassPermissions") return null;
  return `The receiving session runs in ${receiverMode}; Claude would hold a bypass sender's message for user approval. Switch it first with code set-permission-mode --mode bypassPermissions, or pass --allow-held.`;
}

async function wakeCodeSession(session, timeoutMs) {
  const running = () => {
    try { return findPeerRuntime(session, listClaudeCodeCliProcesses()); } catch { return null; }
  };
  const existing = running();
  if (existing) return { woke: false, runtime: existing };
  // Opening the session route makes Claude Desktop start its Claude Code process.
  const via = openClaudeDeepLink(`claude://claude.ai/epitaxy/${encodeURIComponent(session.sessionId)}`);
  const runtime = await waitForCondition(() => running(), timeoutMs).catch(() => null);
  if (!runtime) throw new CliError(`Claude Desktop did not start a process for ${session.sessionId} after opening it`, 2, { via });
  return { woke: true, via, runtime };
}

async function cmdWake(args, surface) {
  if (surface !== "code" || !(args["session-id"] || args.sessionId)) throw new CliError("code wake requires an explicit --session-id");
  const session = resolveSession(surface, args);
  const result = await wakeCodeSession(session, toInt(args["timeout-ms"], 30000));
  printJson({ ok: true, sessionId: session.sessionId, cliSessionId: session.cliSessionId, ...result });
}

async function codePeerAction(args, surface, session, prompt) {
  if (surface !== "code") throw new CliError("peer transport only supports Code sessions");
  const holdRisk = peerPermissionHoldRisk(args["sender-mode"], session.permissionMode);
  if (holdRisk && !toBool(args["allow-held"])) throw new CliError(holdRisk, 2, { receiverMode: session.permissionMode, delivery: "not-sent" });
  const { runtime } = await wakeCodeSession(session, toInt(args["wake-timeout-ms"], 30000));
  const transcriptPath = codeTranscriptPath(session);
  let offset = 0;
  try { offset = fs.statSync(transcriptPath).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const result = await sendPeer(runtime, prompt, {
    senderMode: args["sender-mode"],
    senderSessionId: args["sender-session-id"],
  });
  if (toBool(args.wait)) {
    try {
      Object.assign(result, await waitForPeerReceipt(transcriptPath, runtime, result.messageId, toInt(args["timeout-ms"], DEFAULT_WAIT_TIMEOUT_MS), offset));
      await markPeerMessage(result.outboxPath, result.messageId, "confirmed");
    } catch (error) {
      error.details ||= { delivery: "unknown", messageId: result.messageId, sessionId: runtime.sessionId };
      try { await markPeerMessage(result.outboxPath, result.messageId, error.details.delivery); }
      catch { error.details.outboxUpdateFailed = true; }
      throw error;
    }
  }
  return { bridge: { transport: { kind: "claude-session-peer", ...runtime } }, result };
}

async function cmdPeerProbe(args, surface) {
  if (surface !== "code" || !(args["session-id"] || args.sessionId)) throw new CliError("Code peer-probe requires an explicit --session-id");
  const session = resolveSession(surface, args);
  const runtime = findPeerRuntime(session, listClaudeCodeCliProcesses());
  printJson({ ok: true, sessionId: session.sessionId, cliSessionId: session.cliSessionId, runtime, result: probePeer(runtime) });
}

async function cmdPeerReceipt(args, surface) {
  if (surface !== "code" || !(args["session-id"] || args.sessionId) || !args["message-id"]) throw new CliError("Code peer-receipt requires --session-id and --message-id");
  const session = resolveSession(surface, args);
  const record = findPeerMessageRecord(session.cliSessionId, args["message-id"]);
  const receipt = peerReceipt(createTranscriptTail(codeTranscriptPath(session))(), session.cliSessionId, record.messageId);
  if (receipt?.userMessageObserved) await markPeerMessage(record.recordPath, record.messageId, "confirmed");
  printJson({ ok: true, sessionId: session.cliSessionId, messageId: record.messageId, outboxPath: record.recordPath, delivery: receipt ? (receipt.assistantReplyObserved ? "transcript-confirmed" : "transcript-confirmed-awaiting-reply") : "unknown", receipt });
}

async function sessionAction(args, surface, payload) {
  if (toBool(args["raw-ipc"]) || toBool(args.rawIpc)) {
    return rawIpcAction(args, surface, payload);
  }
  return rendererAction(args, surface, payload);
}

async function readRendererTranscript(args, surface, sessionId) {
  if (toBool(args["raw-ipc"]) || toBool(args.rawIpc)) {
    try {
      const { result } = await rawIpcAction(args, surface, {
        action: "getTranscript",
        apiName: apiNameForSurface(surface),
        sessionId,
        options: {},
      });
      return result.transcript;
    } catch {
      return null;
    }
  }

  const client = await createRendererClient(args, surface);
  if (!client.available) return null;
  const result = await client.evaluate(
    rendererCallExpression({
      action: "getTranscript",
      apiName: apiNameForSurface(surface),
      sessionId,
      options: {},
    }),
  );
  if (!result?.ok) return null;
  return result.transcript;
}

function transcriptFingerprint(entries) {
  return entries.map((entry) => `${entry.role}:${entry.timestampMs}:${entry.text}`).join("\n");
}

function formatTranscript(entries, lines = 20) {
  const selected = entries.slice(-lines);
  return selected
    .map((entry) => {
      const text = entry.text.trim();
      return `[${entry.role}] ${text}`;
    })
    .join("\n\n");
}

async function waitForAssistantReply(surface, args, baselineFingerprint = "") {
  const timeoutMs = toInt(args["timeout-ms"], DEFAULT_WAIT_TIMEOUT_MS);
  const startedAt = Date.now();
  let lastTranscript = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const transcript = readLocalTranscript(surface, args);
      lastTranscript = transcript;
      const fingerprint = transcriptFingerprint(transcript.entries);
      const newAssistant = transcript.entries.some(
        (entry) =>
          String(entry.role).toLowerCase().includes("assistant") &&
          fingerprint !== baselineFingerprint &&
          (!entry.timestampMs || entry.timestampMs >= startedAt - 5000),
      );
      if (newAssistant) {
        return transcript;
      }
    } catch {
      // Session metadata can appear a moment after renderer start returns.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new CliError("timed out waiting for assistant transcript entry", 3, {
    timeoutMs,
    lastSource: lastTranscript?.source || null,
  });
}

async function cmdStatus(args, surface) {
  const cwd = args.cwd ? resolveCwd(args.cwd) : resolveCwd();
  const codeSessions = listCodeSessions({ cwd }).slice(0, 10);
  const coworkSessions = listCoworkSessions({ cwd }).slice(0, 10);
  const [bridge, rawIpc] = await Promise.all([
    createRendererClient(args, surface),
    createMainInspectorClient(args, surface),
  ]);
  const result = {
    ok: true,
    surface,
    cwd,
    defaults: {
      code: defaultsForSurface("code"),
      cowork: defaultsForSurface("cowork"),
    },
    bridge: {
      available: bridge.available,
      reason: bridge.reason || null,
      transport: bridge.transport || null,
      probe: bridge.probe || null,
      registry: bridge.registry || null,
      attempts: bridge.attempts || [],
    },
    rawIpc: {
      available: rawIpc.available,
      inspectorAvailable: Boolean(rawIpc.inspectorAvailable),
      reason: rawIpc.reason || null,
      transport: rawIpc.transport || null,
      registry: rawIpc.registry || null,
      missingRequired: rawIpc.missingRequired || [],
      attempts: rawIpc.attempts || [],
    },
    sessions: {
      code: codeSessions,
      cowork: coworkSessions,
    },
    peerIpc: codeSessions.map((session) => {
      try { return { registered: true, serverVerified: false, ...findPeerRuntime(session, listClaudeCodeCliProcesses()) }; }
      catch (error) { return { registered: false, sessionId: session.cliSessionId, reason: error.message }; }
    }),
    processes: listClaudeProcesses(),
    desktopProcesses: listClaudeDesktopProcesses(),
    desktopMainProcesses: listClaudeDesktopMainProcesses(),
    desktopExecutable: findClaudeDesktopExecutable(),
    claudeCodeCli: {
      executable: findClaudeCodeExecutable(),
      processes: listClaudeCodeCliProcesses(),
      credentialsPath: claudeCodeCredentialsPath,
      desktopOauthCachePresent: fs.existsSync(path.join(claudeDataDir, "config.json")) && fs.existsSync(claudeLocalStatePath),
    },
  };

  if (toBool(args.json)) {
    printJson(result);
  } else {
    process.stdout.write(`surface: ${surface}\n`);
    process.stdout.write(`bridge.available: ${result.bridge.available}\n`);
    if (!result.bridge.available) process.stdout.write(`bridge.reason: ${result.bridge.reason}\n`);
    process.stdout.write(`rawIpc.available: ${result.rawIpc.available}\n`);
    if (!result.rawIpc.available) process.stdout.write(`rawIpc.reason: ${result.rawIpc.reason}\n`);
    process.stdout.write(`code sessions: ${codeSessions.length}\n`);
    process.stdout.write(`cowork sessions: ${coworkSessions.length}\n`);
    process.stdout.write(`claude processes: ${result.processes.length}\n`);
    process.stdout.write(`claude desktop processes: ${result.desktopProcesses.length}\n`);
    process.stdout.write(`claude code cli: ${result.claudeCodeCli.executable || "not found"}\n`);
  }
}

async function cmdBridge(args, surface, rest) {
  const subcommand = String(rest[0] || "ensure").toLowerCase();
  if (!["ensure", "restart", "status"].includes(subcommand)) {
    throw new CliError(`unknown bridge command: ${subcommand}`);
  }

  if (subcommand === "status") {
    await cmdStatus(args, surface);
    return;
  }

  const forceRestart = subcommand === "restart";
  const bootArgs = forceRestart ? { ...args, "restart-claude": true } : args;
  const boot = await bootstrapRendererBridge(bootArgs, surface, { forceRestart });
  const output = {
    ok: boot.ok,
    surface,
    port: boot.port,
    reason: boot.reason || null,
    bridge: boot.client
      ? {
          available: boot.client.available,
          transport: boot.client.transport || null,
          probe: boot.client.probe || null,
          registry: boot.client.registry || null,
        }
      : null,
    steps: boot.steps || [],
    desktopProcesses: listClaudeDesktopProcesses(),
  };

  if (toBool(args.json) || !boot.ok) {
    printJson(output);
  } else {
    process.stdout.write(`bridge.available: ${Boolean(boot.client?.available)}\n`);
    process.stdout.write(`transport: ${boot.client?.transport?.kind || "none"}\n`);
  }

  if (!boot.ok) process.exitCode = 2;
}

async function cmdAuthSync(args) {
  const result = syncClaudeCodeCredentialsFromDesktop(args);
  if (toBool(args.json)) {
    printJson(result);
  } else if (result.skipped) {
    process.stdout.write(`auth-sync skipped: ${result.reason || "requested"}\n`);
  } else {
    process.stdout.write(`auth-sync ok: ${result.changed ? "updated" : "already current"}\n`);
    process.stdout.write(`credentials: ${result.credentialsPath}\n`);
    if (result.backupPath) process.stdout.write(`backup: ${result.backupPath}\n`);
  }
}

async function cmdRaw(args, surface, rest) {
  const subcommand = String(rest[0] || "probe").toLowerCase();
  if (subcommand === "probe" || subcommand === "status") {
    const shouldBootstrap = toBool(args.bootstrap) || toBool(args["allow-bootstrap"]) || toBool(args.allowBootstrap);
    const boot = toBool(args["no-bootstrap"]) || !shouldBootstrap
      ? { ok: false, client: await createMainInspectorClient(args, surface), steps: [] }
      : await bootstrapRawIpcBridge(args, surface);
    const client = boot.client || (boot.ok === false && boot.client) || null;
    const output = {
      ok: Boolean(client?.available),
      surface,
      port: boot.port || mainInspectPort(args),
      reason: boot.reason || client?.reason || null,
      rawIpc: client
        ? {
            available: client.available,
            inspectorAvailable: Boolean(client.inspectorAvailable),
            transport: client.transport || null,
            registry: client.registry || null,
            missingRequired: client.missingRequired || [],
            attempts: client.attempts || [],
          }
        : null,
      steps: boot.steps || [],
      desktopProcesses: listClaudeDesktopProcesses(),
    };
    if (toBool(args.json) || !output.ok) {
      printJson(output);
    } else {
      process.stdout.write(`rawIpc.available: ${output.ok}\n`);
      process.stdout.write(`transport: ${client?.transport?.kind || "none"}\n`);
    }
    if (!output.ok) process.exitCode = 2;
    return;
  }

  if (subcommand === "get-all" || subcommand === "list-runtime") {
    const { bridge, result } = await rawIpcAction({ ...args, "raw-ipc": true }, surface, {
      action: "getAll",
      apiName: apiNameForSurface(surface),
    });
    const output = {
      ok: true,
      surface,
      bridge: bridge.transport,
      sessions: result.sessions,
      rawCalls: result.rawCalls || [],
    };
    if (toBool(args.json)) printJson(output);
    else process.stdout.write(`${JSON.stringify(output.sessions, null, 2)}\n`);
    return;
  }

  if (subcommand === "start") {
    await cmdStart({ ...args, "raw-ipc": true }, surface, rest.slice(1));
    return;
  }

  if (subcommand === "send") {
    await cmdSend({ ...args, "raw-ipc": true }, surface, rest.slice(1));
    return;
  }

  throw new CliError(`unknown raw command: ${subcommand}`);
}

async function cmdList(args, surface) {
  const cwd = args.cwd ? resolveCwd(args.cwd) : undefined;
  const sessions = listSessions(surface, { cwd }).slice(0, toInt(args.limit, 50));
  if (toBool(args.json)) {
    printJson({ ok: true, surface, cwd: cwd || null, sessions });
  } else {
    for (const session of sessions) {
      process.stdout.write(
        `${session.sessionId} ${session.title || ""} ${session.cwd || ""} ${session.model || ""} ${session.effort || ""}\n`,
      );
    }
  }
}

async function cmdStart(args, surface, rest) {
  const prompt = readPrompt(args, rest).trim();
  if (!prompt && !toBool(args.empty)) {
    throw new CliError("start requires --prompt TEXT, --prompt-file PATH, positional text, or --empty");
  }

  const { payload: startPayload, sessionId } = buildStartPayload(surface, args, prompt);
  const forceOps = buildForceOperations(surface, sessionId);
  const sendArgs = buildSendArgs(surface, sessionId, prompt);
  const baseline = "";
  const { bridge, result } = await sessionAction(args, surface, {
    action: "start",
    apiName: apiNameForSurface(surface),
    surface,
    sessionId,
    startPayload,
    forceOps,
    promptAfterStart: Boolean(prompt),
    sendArgs,
  });

  const output = {
    ok: true,
    surface,
    sessionId: result.sessionId || sessionId,
    defaults: defaultsForSurface(surface),
    bridge: bridge.transport,
    result: result.result || result,
  };

  if (toBool(args.wait) && prompt) {
    output.transcript = await waitForAssistantReply(surface, { ...args, "session-id": sessionId }, baseline);
  }

  if (toBool(args.json) || toBool(args.wait)) {
    printJson(output);
  } else {
    process.stdout.write(`${output.sessionId}\n`);
  }
}

async function cmdSend(args, surface, rest) {
  if (!(args["session-id"] || args.sessionId)) throw new CliError("send requires an explicit --session-id; newest or focused sessions are never inferred");
  const prompt = readPrompt(args, rest);
  if (!prompt.trim()) throw new CliError("send requires --prompt TEXT, --prompt-file PATH, or positional text");
  const session = resolveSession(surface, args);
  const before = (() => {
    try {
      return transcriptFingerprint(readLocalTranscript(surface, args).entries);
    } catch {
      return "";
    }
  })();

  const chosenTransport = await chooseSendTransport(args, surface, session);
  const actionArgs =
    chosenTransport === "raw"
      ? { ...args, "raw-ipc": true, "no-bootstrap": sendTransportMode(args) === "auto" ? true : args["no-bootstrap"] }
      : chosenTransport === "renderer" && sendTransportMode(args) === "auto"
        ? { ...args, "no-bootstrap": true }
        : args;

  const forceOps = []; // Sending preserves the recipient's selected model and permissions.
  const sendArgs = buildSendArgs(surface, session.sessionId, prompt);
  const { bridge, result } =
    chosenTransport === "cli"
      ? await codeCliResumeAction(args, surface, session, prompt, before)
      : chosenTransport === "peer"
        ? await codePeerAction(args, surface, session, prompt)
      : chosenTransport === "live-stdin"
        ? await codeLiveStdinAction(args, surface, session, prompt)
      : await sessionAction(actionArgs, surface, {
          action: "send",
          apiName: apiNameForSurface(surface),
          surface,
          sessionId: session.sessionId,
          forceOps,
          sendArgs,
        });

  const output = {
    ok: true,
    surface,
    sessionId: session.sessionId,
    transport: chosenTransport,
    defaults: ['peer', 'live-stdin', 'renderer', 'raw'].includes(chosenTransport) ? null : defaultsForSurface(surface),
    bridge: bridge.transport,
    result,
  };

  if (toBool(args.wait) && !['peer', 'live-stdin'].includes(chosenTransport)) {
    output.transcript = await waitForAssistantReply(surface, args, before);
  }

  if (toBool(args.json) || toBool(args.wait)) {
    printJson(output);
  } else {
    process.stdout.write(`${session.sessionId}\n`);
  }
}

async function cmdRead(args, surface) {
  const session = resolveSession(surface, args);
  const rendererTranscript = toBool(args.renderer)
    ? await readRendererTranscript(args, surface, session.sessionId)
    : null;
  if (rendererTranscript) {
    if (toBool(args.json)) {
      printJson({ ok: true, surface, session, source: "renderer", transcript: rendererTranscript });
    } else {
      process.stdout.write(`${JSON.stringify(rendererTranscript, null, 2)}\n`);
    }
    return;
  }

  const transcript = readLocalTranscript(surface, args);
  const lines = toInt(args.lines, 20);
  if (toBool(args.json)) {
    printJson({ ok: true, surface, session: transcript.session, source: transcript.source, entries: transcript.entries.slice(-lines) });
  } else {
    process.stdout.write(`${formatTranscript(transcript.entries, lines)}\n`);
  }
}

async function cmdWait(args, surface) {
  const baseline = (() => {
    try {
      return transcriptFingerprint(readLocalTranscript(surface, args).entries);
    } catch {
      return "";
    }
  })();
  const transcript = await waitForAssistantReply(surface, args, baseline);
  if (toBool(args.json)) {
    printJson({ ok: true, surface, session: transcript.session, source: transcript.source, entries: transcript.entries });
  } else {
    process.stdout.write(`${formatTranscript(transcript.entries, toInt(args.lines, 20))}\n`);
  }
}

async function cmdSelftest() {
  assert(peerPermissionHoldRisk("bypass", "acceptEdits") !== null, "bypass sender to acceptEdits receiver is flagged as held");
  assert(peerPermissionHoldRisk("bypass", "bypassPermissions") === null, "matching bypass modes are not flagged");
  assert(peerPermissionHoldRisk("prompting", "acceptEdits") === null, "prompting sender is not flagged");
  const createArgs = buildCreateCliArgs({ sessionId: "11111111-2222-4333-8444-555555555555", title: "디자인 리뷰", model: "claude-opus-5-5", effort: "high", permissionMode: "bypassPermissions" });
  assert(createArgs.includes("--allow-dangerously-skip-permissions") && createArgs[createArgs.indexOf("--permission-mode") + 1] === "bypassPermissions", "create starts in bypass when requested");
  assert(createArgs[createArgs.indexOf("--name") + 1] === "디자인 리뷰" && !createArgs.some((arg) => /Reply|READY/.test(arg)), "create passes the title as an argument and keeps the prompt off argv");
  assert(!buildCreateCliArgs({ sessionId: "11111111-2222-4333-8444-555555555555", permissionMode: "default" }).includes("--allow-dangerously-skip-permissions"), "non-bypass create does not request skip permissions");
  assert(resumeDeepLink("11111111-2222-4333-8444-555555555555") === "claude://resume?session=11111111-2222-4333-8444-555555555555", "resume deep link format");
  assert(findImportedSession([{ sessionId: "local_a", cliSessionId: "x", mtimeMs: 1 }, { sessionId: "local_a", cliSessionId: "x", mtimeMs: 2 }], "x").mtimeMs === 2, "mirrored Desktop metadata copies resolve to one imported session");
  let conflictingImport = false;
  try { findImportedSession([{ sessionId: "local_a", cliSessionId: "x" }, { sessionId: "local_b", cliSessionId: "x" }], "x"); } catch { conflictingImport = true; }
  assert(conflictingImport, "two Desktop sessions for one CLI session are rejected");
  assert(selectDesktopInferenceToken({ "acct:a:b:https://api.anthropic.com:user:inference": { token: "t1", expiresAt: 2 }, "acct:a:b:https://api.anthropic.com:user:inference user:office": { token: "t2", expiresAt: 1 } }) === "t1", "newest inference token selected");
  const permissionFrame = JSON.parse(buildPermissionModeControlFrame("bypassPermissions", "request-1"));
  assert(permissionFrame.type === "control_request" && permissionFrame.request_id === "request-1", "permission frame is a control request");
  assert(permissionFrame.request.subtype === "set_permission_mode" && permissionFrame.request.mode === "bypassPermissions", "permission frame carries the requested mode");
  let rejectedMode = false;
  try { buildPermissionModeControlFrame("everything"); } catch { rejectedMode = true; }
  assert(rejectedMode, "unknown permission mode rejected");
  assert(permissionModeLaunchBlocker("claude.exe --permission-mode default --allow-dangerously-skip-permissions --resume=x", "bypassPermissions") === null, "bypass allowed when launch flag present");
  assert(permissionModeLaunchBlocker("claude.exe --permission-mode default --resume=x", "bypassPermissions") !== null, "bypass blocked without launch flag");
  assert(permissionModeLaunchBlocker("claude.exe --permission-mode default --resume=x", "acceptEdits") === null, "non-bypass modes need no launch flag");
  const initialSession = {
    cliSessionId: "target-session",
    createdAt: Date.parse("2026-09-30T16:03:38.634Z"),
    model: "claude-opus-5-5",
    effort: "high",
    permissionMode: "bypassPermissions",
  };
  const initialChild = {
    ProcessId: 123,
    CreationDate: "2026-09-30T16:03:22.499Z",
    CommandLine: "claude.exe --input-format stream-json --output-format stream-json --model claude-opus-5-5 --effort high --permission-mode acceptEdits",
  };
  assert(findLiveClaudeCodeProcessForSession(initialSession, [initialChild]) === null, "initial child without a session ID is never inferred from creation time");
  assert(findLiveClaudeCodeProcessForSession(initialSession, [{ ...initialChild, CreationDate: "2026-09-30T15:00:00Z" }]) === null, "unrelated older initial child rejected");
  assert(findLiveClaudeCodeProcessForSession(initialSession, [initialChild, { ...initialChild, ProcessId: 124 }]) === null, "ambiguous initial children rejected");
  assert(findLiveClaudeCodeProcessForSession({ ...initialSession, createdAt: null }, [initialChild]) === null, "initial child needs a session creation anchor");
  assert(findLiveClaudeCodeProcessForSession(initialSession, [{ ...initialChild, CommandLine: `${initialChild.CommandLine} --resume=other-session` }]) === null, "another resumed session rejected");
  const resumedChild = { ...initialChild, CommandLine: `${initialChild.CommandLine} --resume=target-session` };
  assert(findLiveClaudeCodeProcessForSession(initialSession, [resumedChild]) === resumedChild, "exact resumed session remains supported");
  assert(findLiveClaudeCodeProcessForSession(initialSession, [{ ...resumedChild, CommandLine: `${initialChild.CommandLine} --resume target-session-extra` }]) === null, "session ID prefix rejected");
  const quotedChild = { ...initialChild, CommandLine: `${initialChild.CommandLine} --resume "target-session"` };
  assert(findLiveClaudeCodeProcessForSession(initialSession, [quotedChild]) === quotedChild, "quoted exact resume ID accepted");
  const identifiedChild = { ...initialChild, CommandLine: `${initialChild.CommandLine} --session-id=target-session` };
  assert(findLiveClaudeCodeProcessForSession(initialSession, [identifiedChild]) === identifiedChild, "explicit initial session ID accepted");
  assert(findLiveClaudeCodeProcessForSession(initialSession, [resumedChild, { ...resumedChild, ProcessId: 124 }]) === null, "duplicate exact-session children rejected");
  assert(findLiveClaudeCodeProcessForSession(initialSession, [{ ...resumedChild, CommandLine: `${resumedChild.CommandLine} --session-id=other-session` }]) === null, "conflicting session IDs rejected");
  const registrySession = { ...initialSession, cwd: "C:\\task" };
  const registryRuntime = { sessionId: initialSession.cliSessionId, pid: 123, procStart: "123456", cwd: "C:\\task" };
  const registryProbe = { ok: true, probe: true, sessionId: initialSession.cliSessionId, serverPid: 123, procStart: "123456" };
  assert(runtimeVerifiedStdinProcess(registrySession, [initialChild], registryRuntime, registryProbe) === initialChild, "live registry probe resolves initialized child without command-line session ID");
  assert(runtimeVerifiedStdinProcess(registrySession, [initialChild], registryRuntime, { ...registryProbe, serverPid: 124 }) === null, "different live PID rejected");
  assert(runtimeVerifiedStdinProcess(registrySession, [initialChild], registryRuntime, { ...registryProbe, procStart: "654321" }) === null, "reused PID rejected");
  assert(runtimeVerifiedStdinProcess(registrySession, [initialChild], registryRuntime, { ...registryProbe, sessionId: "other-session" }) === null, "different live session rejected");
  assert(runtimeVerifiedStdinProcess(registrySession, [initialChild], { ...registryRuntime, cwd: "C:\\other" }, registryProbe) === null, "different checkout rejected");
  assert(runtimeVerifiedStdinProcess(registrySession, [resumedChild], registryRuntime, registryProbe) === null, "registry path does not override explicit command-line identity");
  assert(runtimeVerifiedStdinProcess(registrySession, [initialChild, initialChild], registryRuntime, registryProbe) === null, "ambiguous process inventory rejected");
  assert(runtimeVerifiedStdinProcess(registrySession, [{ ...initialChild, CommandLine: "claude.exe" }], registryRuntime, registryProbe) === null, "non-streaming child rejected");
  const cwd = "C:\\Users\\USER\\Desktop\\Projects\\SEMI";
  const prompt = "hello";
  const codeStart = buildStartPayload("code", { cwd, title: "t" }, prompt);
  assert(codeStart.payload.cwd === path.resolve(cwd), "code start cwd");
  assert(codeStart.payload.message === "", "code start uses empty bootstrap message");
  assert(codeStart.payload.model === CODE_MODEL, "code model");
  assert(codeStart.payload.effort === CODE_EFFORT, "code effort");
  assert(codeStart.payload.permissionMode === DEFAULT_PERMISSION_MODE, "code permission mode");
  assert(!Object.prototype.hasOwnProperty.call(codeStart.payload, "settings"), "code start has no invalid settings field");
  assert(!Object.prototype.hasOwnProperty.call(codeStart.payload, "sessionSettings"), "code start has no invalid sessionSettings field");

  const codeForce = buildForceOperations("code", "local_test");
  assert(codeForce.some((op) => op.method === "applyFlagSettings" && op.args[1].ultracode === true), "code ultracode flag");
  assert(codeForce.some((op) => op.method === "setEffort" && op.args[1] === CODE_EFFORT), "code setEffort");
  assert(buildSendArgs("code", "local_test", prompt).length === 5, "code send arity");

  const coworkStart = buildStartPayload("cowork", { cwd, title: "t" }, prompt);
  assert(coworkStart.payload.model === COWORK_MODEL, "cowork model");
  assert(Array.isArray(coworkStart.payload.userSelectedFolders), "cowork folders");
  const coworkForce = buildForceOperations("cowork", "local_test");
  assert(coworkForce.some((op) => op.method === "setEffort" && op.args[1] === COWORK_EFFORT), "cowork max effort");
  assert(buildSendArgs("cowork", "local_test", prompt).length === 6, "cowork send arity");
  assert(expectedEipcSuffixes("code").includes("LocalSessions_$_applyFlagSettings"), "code eipc suffixes");
  assert(expectedEipcSuffixes("cowork").includes("LocalAgentModeSessions_$_sendMessage"), "cowork eipc suffixes");
  assert(requiredRawIpcSuffixes("code").includes("LocalSessions_$_sendMessage"), "code raw required suffixes");
  assert(requiredRawIpcSuffixes("cowork").includes("LocalAgentModeSessions_$_setEffort"), "cowork raw required suffixes");
  const askUserQuestionText = blockText({
    type: "tool_use",
    name: "AskUserQuestion",
    input: {
      questions: [
        {
          header: "Decision",
          question: "Which route should proceed?",
          options: [{ label: "Route A", description: "Keep the current shape." }],
        },
      ],
    },
  });
  assert(askUserQuestionText.includes("Which route should proceed?"), "AskUserQuestion question text");
  assert(askUserQuestionText.includes("Route A - Keep the current shape."), "AskUserQuestion option text");
  assert(blockText({ type: "tool_use", name: "Bash", input: { command: "echo hidden" } }) === "[tool_use:Bash]", "generic tool_use stays compact");

  const routed = routeCommand({ _: ["cowork", "send"], surface: "code" });
  assert(routed.surface === "cowork" && routed.command === "send", "surface command routing");
  const bridgeRoute = routeCommand({ _: ["bridge", "ensure"], surface: "code" });
  assert(bridgeRoute.surface === "code" && bridgeRoute.command === "bridge", "bridge command routing");
  const rawRoute = routeCommand({ _: ["raw", "probe"], surface: "code" });
  assert(rawRoute.surface === "code" && rawRoute.command === "raw" && rawRoute.rest[0] === "probe", "raw command routing");
  const codeRawRoute = routeCommand({ _: ["code", "raw", "send"], surface: "cowork" });
  assert(codeRawRoute.surface === "code" && codeRawRoute.command === "raw" && codeRawRoute.rest[0] === "send", "code raw routing");

  process.stdout.write("selftest ok\n");
}

function assert(condition, message) {
  if (!condition) throw new CliError(`selftest failed: ${message}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { surface, command, rest } = routeCommand(args);

  if (command === 'app-start') { printJson({ ok: true, ...await ensureDesktopReady('claude') }); return; }
  if (!toBool(args['dry-run']) && (toBool(args['start-app']) ||
      ['create', 'read', 'wait', 'wake', 'send', 'set-permission-mode'].includes(command) &&
      (command === 'create' || args['session-id'] || args.sessionId))) await ensureDesktopReady('claude');

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${usage()}\n`);
      return;
    case "status":
      await cmdStatus(args, surface);
      return;
    case "bridge":
      await cmdBridge(args, surface, rest);
      return;
    case "auth-sync":
      await cmdAuthSync(args);
      return;
    case "raw":
      await cmdRaw(args, surface, rest);
      return;
    case "list":
      await cmdList(args, surface);
      return;
    case "start":
      await cmdStart(args, surface, rest);
      return;
    case "send":
      await cmdSend(args, surface, rest);
      return;
    case "peer-probe":
      await cmdPeerProbe(args, surface);
      return;
    case "peer-receipt":
      await cmdPeerReceipt(args, surface);
      return;
    case "wake":
      await cmdWake(args, surface);
      return;
    case "create":
      await cmdCreate(args, surface, rest);
      return;
    case "set-permission-mode":
      await cmdSetPermissionMode(args, surface);
      return;
    case "read":
      await cmdRead(args, surface);
      return;
    case "wait":
      await cmdWait(args, surface);
      return;
    case "selftest":
      await cmdSelftest();
      return;
    default:
      throw new CliError(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  if (toBool(args.json)) {
    printJson({
      ok: false,
      error: error.message || String(error),
      details: error.details || null,
    });
  } else {
    process.stderr.write(`${error.message || error}\n`);
    if (error.details && toBool(args.verbose)) {
      process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    }
  }
  process.exit(error.exitCode || 1);
});
