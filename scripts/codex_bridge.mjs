#!/usr/bin/env node
// codex_bridge.mjs
// External client for the running OpenAI Codex desktop app's inter-thread IPC bus.
//
// send/read/status use codex_app_pipe.mjs (current desktop native tool pipe).
// The explicit --transport ipc and raw commands retain the legacy router below.
// Legacy router transport:
//   - Windows named pipe: \\.\pipe\codex-ipc  (unix: $TMPDIR/codex-ipc/ipc[-uid].sock)
//   - A single "router" process binds the pipe; every window/CLI connects as a client.
//   - Framing: [uint32 LE byteLength][utf8 JSON]   (matches reader fn C3)
//   - Envelope:
//       request : {type:"request", requestId, sourceClientId, version, method, params, targetClientId?, timeoutMs?}
//       response: {type:"response", requestId, resultType:"success"|"error", method, result?, error?}
//       broadcast:{type:"broadcast", method, sourceClientId, params, version}
//       client-discovery-request/response (router-internal capability routing)
//   - Handshake: on connect clientId="initializing-client"; first request MUST be
//     method "initialize" {clientType}; response.result.clientId is your assigned id.
//   - Capability routing: a request with no targetClientId triggers the router to ask
//     every OTHER client "canHandle?"; the client whose registered capability predicate
//     returns true gets the request forwarded. For thread-follower-* the predicate is
//     getThreadRole(params.conversationId) === "owner" -> the window currently showing
//     that thread answers. Version MUST equal the per-method version (Vg map) or the
//     owner answers canHandle:false.
//
// This is NOT a clone/patch: it speaks the live router protocol of the already-running app.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { openAppTools, toolParams, decodeToolResult, loadPrompt } from './codex_app_pipe.mjs';

const PIPE = process.platform === "win32"
  ? "\\\\.\\pipe\\codex-ipc"
  : path.join(os.tmpdir(), "codex-ipc", process.getuid ? `ipc-${process.getuid()}.sock` : "ipc.sock");

// Per-method protocol version (Vg map from src bundle). Default 0.
const VERSION = {
  "thread-stream-state-changed": 11,
  "thread-stream-following-changed": 1,
  "thread-owner-discovery": 1,
  "thread-read-state-changed": 1,
  "thread-archived": 2,
  "thread-unarchived": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-load-complete-history": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 2,
  "thread-follower-update-thread-settings": 1,
  "thread-follower-edit-last-user-turn": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-queued-followups-changed": 1,
};
const ver = (m) => VERSION[m] ?? 0;
const INIT = "initializing-client";

function frame(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const buf = Buffer.allocUnsafe(4 + json.length);
  buf.writeUInt32LE(json.length, 0);
  json.copy(buf, 4);
  return buf;
}

// Streaming reader matching app fn C3: 4-byte LE length prefix then JSON payload.
function makeReader(onMsg) {
  const lenBuf = Buffer.allocUnsafe(4);
  let lenFilled = 0;
  let payload = null;
  let payFilled = 0;
  return (chunk) => {
    let off = 0;
    while (off < chunk.length) {
      if (payload === null) {
        const need = 4 - lenFilled;
        const take = Math.min(need, chunk.length - off);
        chunk.copy(lenBuf, lenFilled, off, off + take);
        lenFilled += take; off += take;
        if (lenFilled < 4) return;
        const len = lenBuf.readUInt32LE(0);
        lenFilled = 0;
        if (len === 0 || len > 268435456) throw new Error(`bad frame length ${len}`);
        payload = Buffer.allocUnsafe(len); payFilled = 0;
      }
      const need = payload.length - payFilled;
      const take = Math.min(need, chunk.length - off);
      chunk.copy(payload, payFilled, off, off + take);
      payFilled += take; off += take;
      if (payFilled < payload.length) return;
      const full = payload; payload = null; payFilled = 0;
      let msg;
      try { msg = JSON.parse(full.toString("utf8")); } catch (e) { continue; }
      onMsg(msg);
    }
  };
}

class CodexBus {
  constructor({ clientType = "claude-codex-bridge", debug = false } = {}) {
    this.clientType = clientType;
    this.debug = debug;
    this.clientId = INIT;
    this.socket = null;
    this.pending = new Map();      // requestId -> {resolve,reject,timer}
    this.eventHandlers = new Set();
  }
  log(...a) { if (this.debug) process.stderr.write("[bridge] " + a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n"); }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(PIPE, async () => {
        this.socket = sock;
        try {
          const res = await this._send("initialize", { clientType: this.clientType }, {});
          if (res.resultType === "success" && res.method === "initialize") {
            this.clientId = res.result.clientId;
            this.log("initialized as", this.clientId);
            resolve(this.clientId);
          } else {
            reject(new Error("initialize failed: " + JSON.stringify(res)));
          }
        } catch (e) { reject(e); }
      });
      sock.on("data", makeReader((m) => this._onMessage(m)));
      sock.on("error", (e) => { this.log("socket error", String(e)); reject(e); });
      sock.on("close", () => {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("connection-closed")); }
        this.pending.clear();
      });
    });
  }

  _write(obj) { this.socket.write(frame(obj)); this.log("->", obj.type, obj.method || "", obj.requestId || ""); }

  _onMessage(m) {
    this.log("<-", m.type, m.method || "", m.requestId || "");
    switch (m.type) {
      case "response": {
        const p = this.pending.get(m.requestId);
        if (p) { this.pending.delete(m.requestId); clearTimeout(p.timer); p.resolve(m); }
        return;
      }
      case "client-discovery-request": {
        // Router asks if we can handle some other client's request. We register nothing.
        this._write({ type: "client-discovery-response", requestId: m.requestId, response: { canHandle: false } });
        return;
      }
      case "broadcast": {
        for (const h of this.eventHandlers) { try { h(m); } catch {} }
        return;
      }
      case "request": {
        // Some client targeted us directly; we handle nothing.
        this._write({ type: "response", requestId: m.requestId, resultType: "error", method: m.method, error: "unsupported" });
        return;
      }
      default: return;
    }
  }

  onEvent(fn) { this.eventHandlers.add(fn); return () => this.eventHandlers.delete(fn); }

  _send(method, params, { targetClientId, timeoutMs = 30000 } = {}) {
    if (!this.socket || !this.socket.writable) return Promise.reject(new Error("not-connected"));
    const req = {
      type: "request",
      requestId: randomUUID(),
      sourceClientId: this.clientId,
      version: ver(method),
      method,
      params,
      ...(targetClientId ? { targetClientId } : {}),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req.requestId); reject(new Error(`timeout:${method}`)); }, timeoutMs);
      this.pending.set(req.requestId, { resolve, reject, timer });
      this._write(req);
    });
  }

  // Public RPC: routed by capability (owner of params.conversationId).
  request(method, params, opts) { return this._send(method, params, opts); }

  close() { try { this.socket?.end(); } catch {} }
}

export { CodexBus, latestThreadId, PIPE, VERSION };

// ---- helpers ----
function latestThreadId() {
  const idx = path.join(os.homedir(), ".codex", "session_index.jsonl");
  try {
    const lines = fs.readFileSync(idx, "utf8").trim().split(/\r?\n/).filter(Boolean);
    let best = null;
    for (const ln of lines) {
      try { const o = JSON.parse(ln); if (o.id) { if (!best || (o.updated_at || "") > (best.updated_at || "")) best = o; } } catch {}
    }
    return best?.id || null;
  } catch { return null; }
}

function readGlobalState() {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", ".codex-global-state.json"), "utf8"));
    const atom = g["electron-persisted-atom-state"] || {};
    return {
      openThreadIds: Object.keys(atom["heartbeat-thread-permissions-by-id"] || {}),
      activeRoots: g["active-workspace-roots"] || [],
      rootLabels: g["electron-workspace-root-labels"] || {},
      threadRootHints: g["thread-workspace-root-hints"] || {},
    };
  } catch { return { openThreadIds: [], activeRoots: [], rootLabels: {}, threadRootHints: {} }; }
}

function listThreads() {
  const idx = path.join(os.homedir(), ".codex", "session_index.jsonl");
  const byId = new Map();
  try {
    for (const ln of fs.readFileSync(idx, "utf8").trim().split(/\r?\n/).filter(Boolean)) {
      try { const o = JSON.parse(ln); if (o.id) byId.set(o.id, { id: o.id, name: o.thread_name || null, updatedAt: o.updated_at || null }); } catch {}
    }
  } catch {}
  const gs = readGlobalState();
  const open = new Set(gs.openThreadIds);
  const rows = [...byId.values()].map((t) => {
    const root = gs.threadRootHints[t.id] || null;
    return { ...t, isOpen: open.has(t.id), workspace: root, workspaceLabel: root ? (gs.rootLabels[root] || null) : null };
  });
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { threads: rows, openThreadIds: gs.openThreadIds, activeRoots: gs.activeRoots, rootLabels: gs.rootLabels };
}

// Resolve a target conversationId from --conversation-id / --thread / --name (thread_name match, prefers open).
function resolveTarget(args) {
  const explicit = args["conversation-id"] || args.thread;
  if (explicit) return explicit;
  const name = args.name;
  if (name) {
    const { threads } = listThreads();
    const needle = String(name).toLowerCase();
    const matches = threads.filter((t) => (t.name || "").toLowerCase().includes(needle));
    if (matches.length > 1) throw new Error(`ambiguous thread name: ${name}; pass --thread`);
    const open = matches.filter((t) => t.isOpen);
    const pick = (open[0] || matches[0]);
    if (!pick) throw new Error(`no thread matching name: ${name}`);
    return pick.id;
  }
  // default: most-recently-updated OPEN thread, else latest overall
  const { threads } = listThreads();
  return (threads.find((t) => t.isOpen) || threads[0])?.id || latestThreadId();
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith("--")) { a[k] = n; i++; } else a[k] = true;
    } else a._.push(t);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "status";
  const debug = !!args.debug;
  const bus = new CodexBus({ debug, clientType: args["client-type"] || "claude-codex-bridge" });

  const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

  if (args.help || cmd === 'help') {
    out({ commands: [
      'status --thread <Codex thread ID>',
      'send --thread <Codex thread ID> --prompt-file <UTF-8 file>',
      'read --thread <Codex thread ID> --turn-limit 2',
      'list',
    ], transport: 'Standalone local Codex app tool pipe; no OmniCodex dependency',
      delivery: 'Send returns the native acknowledgement; read distinguishes queued input from a completed reply. Unknown delivery is not automatically retried.' });
    return;
  }

  // Use the app's own send/read path, including its active-turn handling.
  // This remains a standalone named-pipe client, not an OmniCodex MCP client.
  if (['send', 'read', 'status'].includes(cmd) && args.transport !== 'ipc') {
    let pipe;
    try {
      if (cmd !== 'status' && !args.thread && !args['conversation-id'] && !args.name) {
        throw new Error('Pass --thread <exact thread ID> (no implicit latest-thread send/read)');
      }
      const conversationId = args.thread || args['conversation-id'] ||
        (args.name ? resolveTarget(args) : process.env.CODEX_THREAD_ID);
      if (!conversationId) throw new Error('Pass --thread <exact thread ID>');
      const prompt = cmd === 'send' ? loadPrompt(args) : undefined;
      const ready = await openAppTools(conversationId);
      pipe = ready.pipe;
      if (cmd === 'status') {
        out({ ok: true, transport: 'app-tools-pipe', pipe: pipe.endpoint,
          conversationId, thread: ready.state.thread });
      } else if (cmd === 'read') {
        const result = decodeToolResult(await pipe.request('tools/call', toolParams(conversationId,
          'read_thread', { threadId: conversationId, turnLimit: Number(args['turn-limit'] || 2),
            includeOutputs: false, maxOutputCharsPerItem: 2000 })));
        out({ ok: true, conversationId, response: result });
      } else {
        const callId = randomUUID();
        const result = decodeToolResult(await pipe.request('tools/call', toolParams(conversationId,
          'send_message_to_thread', { threadId: conversationId, prompt }, callId),
          { mutation: true, timeoutMs: 60000 }));
        if (result.threadId !== conversationId) {
          const error = new Error('Send acknowledgement did not identify the intended thread; read before retrying');
          error.delivery = 'unknown';
          throw error;
        }
        out({ ok: true, transport: 'app-tools-pipe', conversationId, callId,
          delivery: 'app-acknowledged', response: result });
      }
    } catch (error) {
      out({ ok: false, error: error.message, ...(error.delivery ? { delivery: error.delivery } : {}) });
      process.exitCode = 1;
    } finally { pipe?.close(); }
    return;
  }

  // 'list' needs no live connection.
  if (cmd === "list") {
    const { threads, activeRoots, rootLabels } = listThreads();
    out({ ok: true, activeRoots, rootLabels, openCount: threads.filter(t => t.isOpen).length, threads: threads.slice(0, 30) });
    return;
  }

  try {
    const clientId = await bus.connect();
    if (cmd === "status") {
      out({ ok: true, pipe: PIPE, clientId, latestThreadId: latestThreadId() });
      bus.close(); return;
    }

    const conversationId = resolveTarget(args);
    if (!conversationId) throw new Error("no target thread (pass --conversation-id, --thread, or --name)");

    if (cmd === "read") {
      const res = await bus.request("thread-follower-load-complete-history", { conversationId }, { timeoutMs: 30000 });
      out({ ok: res.resultType === "success", conversationId, response: res });
      bus.close(); return;
    }

    if (cmd === "send") {
      const text = loadPrompt(args);
      if (!text) throw new Error("no prompt text");
      // Version 2 uses turnStart.request and inherits the target settings.
      const params = {
        conversationId,
        turnStart: {
          request: { threadId: conversationId,
            input: [{ type: "text", text, text_elements: [] }],
            clientUserMessageId: randomUUID() },
          context: { inheritThreadSettings: true },
        },
      };
      const res = await bus.request("thread-follower-start-turn", params, { timeoutMs: 30000 });
      out({ ok: res.resultType === "success", conversationId, sent: text, response: res });
      bus.close(); return;
    }

    if (cmd === "raw") {
      // raw <method> <jsonParams>
      const method = args._[1];
      const params = args.params ? JSON.parse(args.params) : {};
      const res = await bus.request(method, params, { timeoutMs: 30000 });
      out({ ok: res.resultType === "success", method, response: res });
      bus.close(); return;
    }

    throw new Error("unknown command: " + cmd);
  } catch (e) {
    out({ ok: false, error: String(e && (e.stack || e.message) || e) });
    bus.close();
    process.exitCode = 1;
  }
}

import { fileURLToPath } from "node:url";
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();
