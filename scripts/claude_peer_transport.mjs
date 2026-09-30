import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const registryRoot = path.join(os.homedir(), ".claude", "sessions");
const helperPath = fileURLToPath(new URL("./claude_peer_pipe.ps1", import.meta.url));
const outboxRoot = path.join(os.homedir(), ".claude-codex-bridge", "peer-outbox");
const legacyOutboxRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"), "claude-codex-bridge", "peer-outbox");

export function findSessionById(sessions, id) {
  const matches = sessions.filter((session) => session.sessionId === id || session.cliSessionId === id);
  if (matches.length !== 1) throw new Error(`Expected one Claude session for ${id}; found ${matches.length}`);
  return matches[0];
}

function readRecord(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(registryRoot, `${pid}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function findPeerRuntime(session, processes, read = readRecord) {
  if (!session?.cliSessionId) throw new Error("Claude peer requires an explicit session identity");
  const candidates = [];
  for (const process of processes) {
    const pid = Number(process.ProcessId || process.processId);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const record = read(pid);
    if (!record || record.sessionId !== session.cliSessionId) continue;
    if (record.pid !== pid || record.entrypoint !== "claude-desktop") continue;
    if (!record.cwd || !session.cwd || path.win32.resolve(record.cwd).toLowerCase() !== path.win32.resolve(session.cwd).toLowerCase()) continue;
    if (!/^\d+$/.test(record.procStart || "")) continue;
    if (!/^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/i.test(record.messagingSocketPath || "")) continue;
    if (record.peerProtocol !== 1) continue;
    candidates.push({ pid, sessionId: record.sessionId, cwd: record.cwd, procStart: record.procStart, socketPath: record.messagingSocketPath, pidDomain: record.pidDomain });
  }
  if (candidates.length !== 1) throw new Error(`Expected one live Claude peer for ${session.cliSessionId}; found ${candidates.length}`);
  return candidates[0];
}

export function buildPeerFrame(runtime, prompt, messageId = crypto.randomUUID(), options = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Peer message must not be empty");
  if (!["bypass", "prompting"].includes(options.senderMode)) throw new Error("sender-mode must be bypass or prompting and must describe the actual sender permissions");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.senderSessionId || "")) throw new Error("sender-mode requires an explicit valid sender-session-id");
  if (/<\/?cross-session-message\b/i.test(prompt)) throw new Error("Peer permission envelope cannot contain a nested cross-session-message tag");
  // Claude reads permission parity from its canonical peer envelope, not a frame-level flag.
  const content = `<cross-session-message from-session="${options.senderSessionId}" from-name="Codex bridge" from-mode="${options.senderMode}">\n${prompt}\n</cross-session-message>`;
  return {
    type: "user",
    session_id: runtime.sessionId,
    uuid: messageId,
    msg_id: messageId,
    from: "Codex bridge",
    message: { role: "user", content },
  };
}

function deliveryError(message, runtime, messageId, delivery = "unknown") {
  const error = new Error(message);
  error.details = { delivery, sessionId: runtime.sessionId, messageId };
  return error;
}

export function parsePeerHelperReply(output, envelope) {
  try {
    const result = JSON.parse(output.trim());
    if (typeof result?.ok !== "boolean") throw new Error("Missing acknowledgement status");
    return result;
  } catch {
    throw deliveryError("Claude peer helper returned an invalid acknowledgement; delivery is unknown. Read the target before retrying.", envelope.runtime, envelope.frame?.uuid || null, envelope.probe ? "not-sent" : "unknown");
  }
}

function runHelper(envelope) {
  let output;
  try {
    output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath], {
      input: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw deliveryError("Claude peer helper did not return an acknowledgement; delivery is unknown. Read the target before retrying.", envelope.runtime, envelope.frame?.uuid || null, envelope.probe ? "not-sent" : "unknown");
  }
  const result = parsePeerHelperReply(output, envelope);
  if (!result.ok) {
    const error = new Error(`Claude peer transport failed: ${result.error}`);
    error.details = { delivery: result.delivery, sessionId: envelope.runtime.sessionId, messageId: envelope.frame?.uuid || null };
    throw error;
  }
  return result;
}

export async function withPeerOutboxLock(recordPath, action) {
  const normalized = process.platform === "win32" ? path.resolve(recordPath).toLowerCase() : path.resolve(recordPath);
  const name = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  // Windows releases the named-pipe reservation even after a forced process exit.
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\claude-outbox-${name}` : path.join(os.tmpdir(), `claude-outbox-${name}.sock`);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(error.code === "EADDRINUSE" ? new Error("Claude peer request is being updated by another bridge process; no message sent") : error));
    server.listen(endpoint, resolve);
  });
  try { return await action(); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function writeOutbox(recordPath, record) {
  const temporary = `${recordPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, recordPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export async function reservePeerMessage(runtime, prompt, root = outboxRoot) {
  const hash = crypto.createHash("sha256").update(JSON.stringify([runtime.sessionId, prompt])).digest("hex");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const recordPath = path.join(root, `${hash}.json`);
  return withPeerOutboxLock(recordPath, () => {
    const legacyPath = path.join(legacyOutboxRoot, `${hash}.json`);
    if (root === outboxRoot && !fs.existsSync(recordPath) && fs.existsSync(legacyPath)) fs.copyFileSync(legacyPath, recordPath, fs.constants.COPYFILE_EXCL);
    if (fs.existsSync(recordPath)) {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(recordPath, "utf8")); } catch { throw new Error("Claude peer outbox record is corrupt; no message sent"); }
      if (!["confirmed", "not-sent"].includes(previous.state)) throw deliveryError("This prompt already has an unconfirmed request for the selected session. Read its receipt; do not resend.", runtime, previous.messageId);
    }
    const record = { sessionId: runtime.sessionId, messageId: crypto.randomUUID(), state: "prepared", createdAt: new Date().toISOString() };
    writeOutbox(recordPath, record);
    return { ...record, recordPath };
  });
}

export async function markPeerMessage(recordPath, messageId, state) {
  return withPeerOutboxLock(recordPath, () => {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (record.messageId !== messageId) return;
    writeOutbox(recordPath, { ...record, state, updatedAt: new Date().toISOString() });
  });
}

export function findPeerMessageRecord(sessionId, messageId, roots = [outboxRoot, legacyOutboxRoot]) {
  const matches = [];
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const recordPath = path.join(root, name);
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      if (record.sessionId === sessionId && record.messageId === messageId) matches.push({ ...record, recordPath });
    }
  }
  if (!matches.length) throw new Error("No outbox request matches the selected session and message ID");
  const hashes = new Set(matches.map((record) => path.basename(record.recordPath)));
  if (hashes.size !== 1) throw new Error("Ambiguous outbox request; no receipt updated");
  return matches[0];
}

export function probePeer(runtime) {
  return runHelper({ runtime, probe: true });
}

export function validatePeerKey(key, runtime) {
  if (!/^[0-9a-f]{32}$/.test(key.peerToken || "")) throw new Error("Claude peer inbox key is invalid");
  if (key.pidDomain !== runtime.pidDomain || key.procStartFt !== runtime.procStart) throw new Error("Claude peer inbox key does not match the selected runtime");
}

export async function sendPeer(runtime, prompt, options = {}) {
  const frame = buildPeerFrame(runtime, prompt, crypto.randomUUID(), options);
  // The key is Claude's local inbox key, not an account/OAuth credential.
  const hash = crypto.createHash("sha256").update(runtime.socketPath.toLowerCase()).digest("hex");
  const key = JSON.parse(fs.readFileSync(path.join(registryRoot, `${runtime.pid}.${hash}.key`), "utf8"));
  validatePeerKey(key, runtime);
  const reservation = await reservePeerMessage(runtime, prompt);
  frame.uuid = frame.msg_id = reservation.messageId;
  try {
    const result = runHelper({ runtime, frame, auth: { type: "auth", token: key.peerToken } });
    await markPeerMessage(reservation.recordPath, frame.uuid, "written-unconfirmed");
    return { ...result, messageId: frame.uuid, outboxPath: reservation.recordPath, delivery: "written-unconfirmed" };
  } catch (error) {
    const failure = error.details ? error : deliveryError(error.message, runtime, frame.uuid);
    try { await markPeerMessage(reservation.recordPath, frame.uuid, failure.details.delivery === "not-sent" ? "not-sent" : "unknown"); }
    catch { failure.details.outboxUpdateFailed = true; }
    throw failure;
  }
}

export function peerReceipt(entries, sessionId, messageId) {
  const index = entries.findIndex((entry) => entry.type === "user" && entry.uuid === messageId && entry.sessionId === sessionId);
  if (index < 0) return null;
  const descendants = new Set([messageId]);
  const replies = [];
  for (const entry of entries.slice(index + 1)) {
    if (entry.sessionId !== sessionId || !descendants.has(entry.parentUuid)) continue;
    const toolResult = Array.isArray(entry.message?.content) && entry.message.content.some((block) => block.type === "tool_result");
    if (entry.type === "user" && !toolResult && (!entry.isMeta || entry.origin?.kind === "peer")) break;
    if (entry.uuid) descendants.add(entry.uuid);
    if (entry.type === "assistant") replies.push(entry);
  }
  const text = replies.flatMap((entry) => Array.isArray(entry.message?.content) ? entry.message.content.filter((block) => block.type === "text").map((block) => block.text) : []).join("\n");
  return { messageId, sessionId, userMessageObserved: true, assistantReplyObserved: Boolean(text), assistantText: text };
}

export function createTranscriptTail(transcriptPath, initialOffset = 0) {
  let offset = initialOffset;
  let decoder = new StringDecoder("utf8");
  let remainder = "";
  const entries = [];
  return () => {
    let fd;
    try {
      fd = fs.openSync(transcriptPath, "r");
      const size = fs.fstatSync(fd).size;
      if (size < offset) { offset = 0; remainder = ""; entries.length = 0; decoder = new StringDecoder("utf8"); }
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size - offset)));
      while (offset < size) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!count) break;
        offset += count;
        remainder += decoder.write(buffer.subarray(0, count));
        let newline;
        while ((newline = remainder.indexOf("\n")) >= 0) {
          const line = remainder.slice(0, newline);
          remainder = remainder.slice(newline + 1);
          if (!line.trim()) continue;
          try { entries.push(JSON.parse(line)); } catch { /* Only complete transcript lines are considered. */ }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return entries;
  };
}

export async function waitForPeerReceipt(transcriptPath, runtime, messageId, timeoutMs = 120000, initialOffset = 0) {
  const deadline = Date.now() + timeoutMs;
  const readTail = createTranscriptTail(transcriptPath, initialOffset);
  let receipt = null;
  while (Date.now() < deadline) {
    receipt = peerReceipt(readTail(), runtime.sessionId, messageId);
    if (receipt?.assistantReplyObserved) return { ...receipt, delivery: "transcript-confirmed", transcriptPath };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const error = new Error(receipt ? "Claude received the peer message but no assistant reply was observed before timeout. Do not resend." : "Peer message receipt was not observed in the target transcript; delivery is unknown. Do not resend.");
  error.delivery = receipt ? "transcript-confirmed-awaiting-reply" : "unknown";
  error.messageId = messageId;
  error.details = { delivery: error.delivery, messageId, sessionId: runtime.sessionId };
  throw error;
}
