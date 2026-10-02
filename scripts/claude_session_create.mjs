import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Creates a Claude Desktop Code session without the in-app start card:
// 1. run Claude Desktop's own claude.exe once in print mode with an explicit --session-id,
// 2. hand that CLI session to Claude Desktop through its claude://resume deep link,
// 3. wait until Desktop's session metadata lists the same CLI session ID.

export const CREATE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

export function buildCreateCliArgs({ sessionId, title, model, effort, permissionMode }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId || "")) {
    throw new Error("create requires a UUID session ID");
  }
  if (!CREATE_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`--permission-mode must be one of ${CREATE_PERMISSION_MODES.join(", ")}`);
  }
  // The prompt travels on stdin, so Korean text and quotes never pass through the Windows command line.
  const args = ["--print", "--output-format", "json", "--session-id", sessionId, "--permission-mode", permissionMode];
  if (permissionMode === "bypassPermissions") args.push("--allow-dangerously-skip-permissions");
  if (title) args.push("--name", title);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

export function resumeDeepLink(sessionId) {
  return `claude://resume?session=${encodeURIComponent(sessionId)}`;
}

export function findImportedSession(sessions, cliSessionId) {
  const matches = sessions.filter((session) => session.cliSessionId === cliSessionId);
  const identities = new Set(matches.map((session) => session.sessionId));
  if (identities.size > 1) throw new Error(`Claude Desktop lists ${identities.size} sessions for CLI session ${cliSessionId}`);
  return matches.sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0))[0] || null;
}

function assertDirectory(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("create requires an absolute --cwd");
  const stat = fs.statSync(cwd, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`--cwd is not a directory: ${cwd}`);
}

async function waitFor(check, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * deps: {
 *   executablePath: string,
 *   inferenceToken: () => string,               // Desktop OAuth token, given only to the child process
 *   runCli: (exe, args, { cwd, env, input, timeoutMs }) => Promise<{ code, stdout, stderr }>,
 *   transcriptPath: (cwd, sessionId) => string,
 *   openUrl: (url) => void,
 *   listCodeSessions: () => Array<session>,
 * }
 */
export async function createCodeSession(options, deps) {
  const { cwd, prompt, title, model, effort, timeoutMs = 180000, importTimeoutMs = 30000, open = true } = options;
  const permissionMode = options.permissionMode || "bypassPermissions";
  assertDirectory(cwd);
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("create requires a non-empty prompt");

  const sessionId = options.sessionId || crypto.randomUUID();
  const args = buildCreateCliArgs({ sessionId, title, model, effort, permissionMode });
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: deps.inferenceToken() };
  const run = await deps.runCli(deps.executablePath, args, { cwd, env, input: prompt, timeoutMs });

  let firstTurn = null;
  try { firstTurn = JSON.parse(String(run.stdout || "").trim()); } catch { /* reported below */ }
  if (run.code !== 0 || !firstTurn || firstTurn.is_error || firstTurn.session_id !== sessionId) {
    const error = new Error(`Claude Code first turn failed: ${firstTurn?.result || String(run.stderr || run.stdout || "").slice(-400)}`);
    error.details = { stage: "first-turn", sessionId, exitCode: run.code, desktopImported: false };
    throw error;
  }

  const transcript = deps.transcriptPath(cwd, sessionId);
  if (!fs.existsSync(transcript)) {
    const error = new Error(`First turn finished but its transcript is missing: ${transcript}`);
    error.details = { stage: "transcript", sessionId, desktopImported: false };
    throw error;
  }

  const result = {
    cliSessionId: sessionId,
    cwd,
    title: title || null,
    permissionMode,
    transcriptPath: transcript,
    firstReply: firstTurn.result,
    desktopSessionId: null,
    desktopImported: false,
  };
  if (!open) return result;

  deps.openUrl(resumeDeepLink(sessionId));
  const imported = await waitFor(() => findImportedSession(deps.listCodeSessions(), sessionId), importTimeoutMs);
  if (!imported) {
    const error = new Error("Claude Desktop did not list the session after the resume deep link. Do not create another session; open the link again or check Desktop.");
    error.details = { stage: "desktop-import", ...result, deepLink: resumeDeepLink(sessionId) };
    throw error;
  }
  return {
    ...result,
    desktopSessionId: imported.sessionId,
    desktopTitle: imported.title || null,
    desktopPermissionMode: imported.permissionMode || null,
    desktopCwd: imported.cwd || null,
    desktopImported: true,
  };
}
