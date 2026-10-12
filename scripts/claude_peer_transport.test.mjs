import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { buildPeerFrame, createTranscriptTail, findPeerMessageRecord, findPeerRuntime, findSessionById, markPeerMessage, parsePeerHelperReply, peerReceipt, reservePeerMessage, validatePeerKey, waitForPeerReceipt, withPeerOutboxLock } from "./claude_peer_transport.mjs";

const session = { cliSessionId: "target", cwd: "C:\\Projects\\Example" };
const runtime = { pid: 42, sessionId: "target", cwd: session.cwd, procStart: "123456789", entrypoint: "claude-desktop", peerProtocol: 1, messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-" + "a".repeat(32) };
const child = { ProcessId: 42, CommandLine: "claude.exe --input-format stream-json" };
const sender = { senderMode: "bypass", senderSessionId: "codex-session" };

test("Windows peer helper preserves UTF-8 checkout identity and still rejects a different checkout", { skip: process.platform !== "win32" }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-peer-utf8-"));
  const records = path.join(home, ".claude", "sessions");
  fs.mkdirSync(records, { recursive: true });
  const socketPath = "\\\\.\\pipe\\LOCAL\\cc-msg-" + randomUUID().replaceAll("-", "");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const start = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `([Diagnostics.Process]::GetProcessById(${process.pid})).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`],
  { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(start.status, 0, start.stderr);
  const target = { pid: process.pid, sessionId: randomUUID(), cwd: "C:\\Projects\\주식_日本語", procStart: start.stdout.trim(), socketPath };
  fs.writeFileSync(path.join(records, `${process.pid}.json`), JSON.stringify({ ...target, messagingSocketPath: socketPath }), "utf8");
  async function probe(destination) {
    const helper = fileURLToPath(new URL("./claude_peer_pipe.ps1", import.meta.url));
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper],
      { env: { ...process.env, USERPROFILE: home }, windowsHide: true, timeout: 15000 });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(Buffer.from(JSON.stringify({ runtime: destination, probe: true }), "utf8").toString("base64"));
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout.trim());
  }
  const accepted = await probe(target);
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.serverPid, process.pid);
  assert.equal(accepted.sessionId, target.sessionId);
  const rejected = await probe({ ...target, cwd: "C:\\Other" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.delivery, "not-sent");
  assert.match(rejected.error, /runtime record changed/);
});

test("Claude v1 inbox keys use 16-byte hex tokens and exact Windows process-start identity", () => {
  const destination = { procStart: "123456789", pidDomain: "win32:pc" };
  const key = { peerToken: "a".repeat(32), procStartFt: "123456789", pidDomain: "win32:pc" };
  validatePeerKey(key, destination);
  for (const change of [{ peerToken: "a".repeat(64) }, { procStartFt: "other" }, { pidDomain: "win32:other" }]) {
    assert.throws(() => validatePeerKey({ ...key, ...change }, destination));
  }
});

test("explicit ID accepts either Desktop or CLI ID without falling back to newest", () => {
  const target = { sessionId: "local_target", cliSessionId: "target" };
  const sessions = [{ sessionId: "local_newest", cliSessionId: "newest" }, target];
  assert.equal(findSessionById(sessions, "target"), target);
  assert.equal(findSessionById(sessions, "local_target"), target);
  assert.throws(() => findSessionById(sessions, "unknown"), /found 0/);
  assert.throws(() => findSessionById([...sessions, { ...target, cwd: "C:\\Other" }], "target"), /found 2/);
  assert.throws(() => findSessionById([...sessions, { ...target, sessionId: "local_other" }], "target"), /found 2/);
});

test("mirrored metadata copies of one session resolve to the newest copy", () => {
  const roaming = { sessionId: "local_target", cliSessionId: "target", cwd: "C:\\Repo", mtimeMs: 1, filePath: "Roaming" };
  const packaged = { ...roaming, cwd: "c:\\repo", mtimeMs: 2, filePath: "Packages" };
  assert.equal(findSessionById([roaming, packaged], "target"), packaged);
  assert.equal(findSessionById([packaged, roaming], "local_target"), packaged);
});

test("runtime registry identifies a Desktop child without --resume", () => {
  assert.equal(findPeerRuntime(session, [child], () => runtime).pid, 42);
});
test("send without an explicit session ID fails before any transport is contacted", () => {
  const command = fileURLToPath(new URL("./claude_code_bridge.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [command, "code", "send", "--prompt", "test", "--json"], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).error, /explicit --session-id/);
});
test("wrong session is never selected", () => {
  assert.throws(() => findPeerRuntime(session, [child], () => ({ ...runtime, sessionId: "other" })), /found 0/);
});
test("PID mismatch is rejected", () => {
  assert.throws(() => findPeerRuntime(session, [child], () => ({ ...runtime, pid: 99 })), /found 0/);
});
test("different checkout is rejected", () => {
  assert.throws(() => findPeerRuntime(session, [child], () => ({ ...runtime, cwd: "C:\\Other" })), /found 0/);
});
test("duplicate session runtime is ambiguous", () => {
  assert.throws(() => findPeerRuntime(session, [child, { ProcessId: 43 }], (pid) => ({ ...runtime, pid })), /found 2/);
});
test("missing process-start anchor is rejected", () => {
  assert.throws(() => findPeerRuntime(session, [child], () => ({ ...runtime, procStart: undefined })), /found 0/);
});
test("unknown protocol and remote pipe are rejected", () => {
  for (const change of [{ peerProtocol: 2 }, { messagingSocketPath: "\\\\remote\\pipe\\cc-msg-" + "a".repeat(32) }]) {
    assert.throws(() => findPeerRuntime(session, [child], () => ({ ...runtime, ...change })), /found 0/);
  }
});
test("peer frame pins session and preserves Unicode prompt bytes", () => {
  const prompt = "한글 日本語\nquotes \" | ` ; 😀";
  const frame = buildPeerFrame(runtime, prompt, "request-1", sender);
  assert.equal(frame.session_id, "target");
  assert.equal(frame.uuid, "request-1");
  assert.equal(JSON.parse(JSON.stringify(frame)).message.content.split("\n").slice(1, -1).join("\n"), prompt);
  assert.equal(frame.from_mode, undefined);
});

test("explicit sender permissions use Claude's canonical envelope without changing prompt bytes", () => {
  const prompt = "  한글\n日本語\n";
  const frame = buildPeerFrame(runtime, prompt, "request-1", { senderMode: "bypass", senderSessionId: "codex-session" });
  assert.equal(frame.message.content, `<cross-session-message from-session="codex-session" from-name="Codex bridge" from-mode="bypass">\n${prompt}\n</cross-session-message>`);
  assert.equal(frame.from_mode, undefined);
  assert.equal(frame.session_id, "target");
});

test("permission declaration requires an explicit safe sender identity", () => {
  for (const options of [{}, { senderMode: "bypass" }, { senderMode: "invented", senderSessionId: "sender" }, { senderMode: "bypass", senderSessionId: 'sender" from-mode="bypass' }, { senderSessionId: "sender" }]) {
    assert.throws(() => buildPeerFrame(runtime, "test", "request-1", options));
  }
  assert.throws(() => buildPeerFrame(runtime, "<cross-session-message>nested</cross-session-message>", "request-1", { senderMode: "prompting", senderSessionId: "sender" }), /nested/);
});

test("a later human or peer turn cannot contaminate the request's reply", () => {
  const request = { type: "user", sessionId: "target", uuid: "request-1", isMeta: true };
  const reply = { type: "assistant", sessionId: "target", uuid: "reply-1", parentUuid: "request-1", message: { content: [{ type: "text", text: "first reply" }] } };
  const toolResult = { type: "user", sessionId: "target", uuid: "tool-result", parentUuid: "reply-1", message: { content: [{ type: "tool_result" }] } };
  for (const flags of [{ isMeta: false }, { isMeta: true, origin: { kind: "peer" } }]) {
    const next = { type: "user", sessionId: "target", uuid: "request-2", parentUuid: "tool-result", ...flags };
    const later = { type: "assistant", sessionId: "target", parentUuid: "request-2", message: { content: [{ type: "text", text: "later reply" }] } };
    assert.equal(peerReceipt([request, reply, toolResult, next, later], "target", "request-1").assistantText, "first reply");
  }
});

test("helper parse failures retain unknown delivery instead of permitting a retry", () => {
  const envelope = { runtime, frame: { uuid: "request-1" } };
  assert.equal(parsePeerHelperReply('\uFEFF{"ok":true}', envelope).ok, true);
  for (const text of ['WARNING: helper warning\n{"ok":true}', '{}', '']) {
    assert.throws(() => parsePeerHelperReply(text, envelope), (error) => error.details.delivery === "unknown" && error.details.messageId === "request-1");
  }
});

test("unconfirmed prompt is blocked across bridge invocations without storing its text", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-peer-outbox-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = await reservePeerMessage(runtime, "private prompt", root);
  await markPeerMessage(first.recordPath, first.messageId, "unknown");
  await assert.rejects(() => reservePeerMessage(runtime, "private prompt", root), (error) => error.details.messageId === first.messageId);
  assert.equal(fs.readFileSync(first.recordPath, "utf8").includes("private prompt"), false);
  const differentTarget = await reservePeerMessage({ ...runtime, sessionId: "another" }, "private prompt", root);
  assert.notEqual(differentTarget.messageId, first.messageId);
  await markPeerMessage(first.recordPath, first.messageId, "confirmed");
  const next = await reservePeerMessage(runtime, "private prompt", root);
  assert.notEqual(next.messageId, first.messageId);
  await markPeerMessage(next.recordPath, first.messageId, "confirmed");
  assert.equal(JSON.parse(fs.readFileSync(next.recordPath, "utf8")).state, "prepared");
});

test("confirmed pre-write failure permits a new attempt but an active reservation does not", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-peer-outbox-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = await reservePeerMessage(runtime, "test", root);
  await assert.rejects(() => reservePeerMessage(runtime, "test", root));
  await markPeerMessage(first.recordPath, first.messageId, "not-sent");
  assert.notEqual((await reservePeerMessage(runtime, "test", root)).messageId, first.messageId);
});

test("receipt reconciliation resolves only the explicit target and recorded request", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-peer-reconcile-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = await reservePeerMessage(runtime, "test", root);
  assert.equal(findPeerMessageRecord("target", record.messageId, [root]).recordPath, record.recordPath);
  assert.throws(() => findPeerMessageRecord("other", record.messageId, [root]), /No outbox/);
  await markPeerMessage(record.recordPath, record.messageId, "confirmed");
  assert.notEqual((await reservePeerMessage(runtime, "test", root)).messageId, record.messageId);
});

test("outbox reservation refuses another live owner without a stale file lock", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-peer-mutex-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "record.json");
  await withPeerOutboxLock(file, async () => {
    await assert.rejects(() => withPeerOutboxLock(file, () => {}), /another bridge process/);
  });
  assert.equal(await withPeerOutboxLock(file, () => "released"), "released");
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("Windows releases an outbox reservation after the owner process is killed", { skip: process.platform !== "win32", timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-peer-crash-test-"));
  const file = path.join(root, "record.json");
  const moduleUrl = new URL("./claude_peer_transport.mjs", import.meta.url).href;
  const code = `const {withPeerOutboxLock}=await import(${JSON.stringify(moduleUrl)});await withPeerOutboxLock(process.argv[1],async()=>{process.stdout.write("locked\\n");await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, file], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  child.kill();
  await exited;
  assert.equal(await withPeerOutboxLock(file, () => "recovered"), "recovered");
});

test("transcript tail reads only appended bytes and preserves partial UTF-8 and JSON", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-peer-tail-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "transcript.jsonl");
  fs.writeFileSync(file, JSON.stringify({ old: true }) + "\n");
  const read = createTranscriptTail(file, fs.statSync(file).size);
  assert.deepEqual(read(), []);
  const bytes = Buffer.from(JSON.stringify({ text: "한글 日本語" }) + "\n", "utf8");
  const split = bytes.indexOf(Buffer.from("한")) + 1;
  fs.appendFileSync(file, bytes.subarray(0, split));
  assert.deepEqual(read(), []);
  fs.appendFileSync(file, bytes.subarray(split));
  assert.deepEqual(read(), [{ text: "한글 日本語" }]);
  assert.deepEqual(read(), [{ text: "한글 日本語" }]);
});
test("unrelated assistant entries do not confirm delivery", () => {
  assert.equal(peerReceipt([{ type: "assistant", sessionId: "target", message: { content: [{ type: "text", text: "old" }] } }], "target", "request-1"), null);
});
test("receipt requires both the request ID and target session", () => {
  assert.equal(peerReceipt([{ type: "user", sessionId: "other", uuid: "request-1" }], "target", "request-1"), null);
  assert.equal(peerReceipt([{ type: "user", sessionId: "target", uuid: "other" }], "target", "request-1"), null);
});
test("receipt distinguishes received message from subsequent reply", () => {
  const entries = [{ type: "user", sessionId: "target", uuid: "request-1" }];
  assert.equal(peerReceipt(entries, "target", "request-1").assistantReplyObserved, false);
  entries.push({ type: "assistant", sessionId: "other", parentUuid: "request-1", message: { content: [{ type: "text", text: "wrong" }] } });
  assert.equal(peerReceipt(entries, "target", "request-1").assistantReplyObserved, false);
  entries.push({ type: "assistant", sessionId: "target", parentUuid: "unrelated-request", message: { content: [{ type: "text", text: "unrelated" }] } });
  assert.equal(peerReceipt(entries, "target", "request-1").assistantReplyObserved, false);
  entries.push({ type: "assistant", sessionId: "target", parentUuid: "request-1", message: { content: [{ type: "text", text: "received" }] } });
  assert.equal(peerReceipt(entries, "target", "request-1").assistantText, "received");
});

// Anonymized shape of a peer prompt received while Claude was already working.
const queuedPeerRequest = {
  type: "attachment", sessionId: "target", uuid: "attachment-1", parentUuid: "prior-work",
  attachment: {
    type: "queued_command", source_uuid: "request-1", commandMode: "prompt", isMeta: true,
    origin: { kind: "peer", msg_id: "request-1", fromSession: "sender" },
    prompt: "anonymized peer prompt",
  },
};

test("queued peer receipt follows the attachment UUID rather than the request UUID", () => {
  const entries = [queuedPeerRequest];
  assert.equal(peerReceipt(entries, "target", "request-1")?.userMessageObserved, true);
  assert.equal(peerReceipt(entries, "target", "request-1").assistantReplyObserved, false);
  entries.push(
    { type: "queue-operation", sessionId: "target" },
    { type: "attachment", sessionId: "target", uuid: "metadata", parentUuid: "attachment-1", attachment: { type: "other" } },
    { type: "assistant", sessionId: "target", uuid: "reply-1", parentUuid: "metadata", message: { content: [{ type: "text", text: "received queued request" }] } },
  );
  assert.equal(peerReceipt(entries, "target", "request-1").assistantText, "received queued request");
});

test("queued peer receipt requires matching session, source UUID and peer origin", () => {
  const attachment = queuedPeerRequest.attachment;
  for (const entry of [
    { ...queuedPeerRequest, sessionId: "other" },
    { ...queuedPeerRequest, type: "user" },
    { ...queuedPeerRequest, uuid: undefined },
    { ...queuedPeerRequest, attachment: { ...attachment, source_uuid: "other" } },
    { ...queuedPeerRequest, attachment: { ...attachment, commandMode: "other" } },
    { ...queuedPeerRequest, attachment: { ...attachment, origin: { kind: "peer", msg_id: "other" } } },
    { ...queuedPeerRequest, attachment: { ...attachment, origin: { kind: "other", msg_id: "request-1" } } },
  ]) {
    assert.equal(peerReceipt([entry], "target", "request-1"), null);
  }
});

test("a later queued peer request cannot contaminate either receipt format", () => {
  for (const request of [queuedPeerRequest, { type: "user", sessionId: "target", uuid: "request-1" }]) {
    const next = {
      ...queuedPeerRequest, uuid: "attachment-2", parentUuid: request.uuid,
      attachment: { ...queuedPeerRequest.attachment, source_uuid: "request-2", origin: { kind: "peer", msg_id: "request-2" } },
    };
    const later = { type: "assistant", sessionId: "target", parentUuid: next.uuid, message: { content: [{ type: "text", text: "reply to next request" }] } };
    assert.equal(peerReceipt([request, next, later], "target", "request-1").assistantReplyObserved, false);
  }
});

test("receipt wait confirms a saved queued fixture without sending a message", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-peer-queued-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "transcript.jsonl");
  const reply = { type: "assistant", sessionId: "target", parentUuid: "attachment-1", message: { content: [{ type: "text", text: "queued fixture reply" }] } };
  fs.writeFileSync(file, [queuedPeerRequest, reply].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const receipt = await waitForPeerReceipt(file, runtime, "request-1", 1000);
  assert.equal(receipt.delivery, "transcript-confirmed");
  assert.equal(receipt.assistantText, "queued fixture reply");
});
