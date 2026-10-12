// Same-user Codex desktop tool pipe. No OmniCodex process, imports or state.
import net from 'node:net';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureDesktopReady } from './desktop_lifecycle.mjs';

export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > 8388608) throw new Error('App tool request exceeds 8 MiB');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class AppToolPipe {
  constructor(endpoint, { timeoutMs = 15000 } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = this.socket = net.connect(this.endpoint);
      const timer = setTimeout(() => {
        reject(new Error('App tool pipe connection timed out'));
        socket.destroy();
      }, this.timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('error', error => { clearTimeout(timer); reject(error); this.failPending(error); });
      socket.on('close', () => this.failPending(new Error('App tool pipe disconnected')));
      socket.on('data', chunk => {
        try {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (!length || length > 8388608) throw new Error('Invalid app tool frame length');
            if (this.buffer.length < length + 4) break;
            const response = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
            this.buffer = this.buffer.subarray(length + 4);
            const pending = this.pending.get(response.id);
            if (!pending) continue;
            this.pending.delete(response.id);
            clearTimeout(pending.timer);
            if (response.error) {
              const error = new Error(response.error.message);
              error.code = response.error.code;
              pending.reject(error);
            } else pending.resolve(response.result);
          }
        } catch (error) { this.failPending(error); socket.destroy(); }
      });
    });
    return this;
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params, { mutation = false, timeoutMs = this.timeoutMs } = {}) {
    if (!this.socket?.writable) return Promise.reject(new Error('App tool pipe not connected'));
    const id = randomUUID();
    const bytes = encodeFrame({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    return new Promise((resolve, reject) => {
      const fail = error => {
        if (mutation) {
          error.delivery = 'unknown';
          error.message += '; delivery unknown: read the target before retrying; no automatic resend';
        }
        reject(error);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`App tool request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject: fail, timer });
      this.socket.write(bytes, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        fail(error);
      });
    });
  }

  close() { this.socket?.destroy(); }
}

export function toolParams(threadId, tool, args, callId = randomUUID()) {
  return {
    // Product-side context required by the desktop protocol, not a model identity.
    callerSource: 'codex', namespace: 'codex_app', tool,
    threadId, turnId: `claude-bridge-${callId}`, callId, arguments: args,
  };
}

export function decodeToolResult(result) {
  if (!result || result.success !== true || !Array.isArray(result.contentItems)) {
    throw new Error(`Codex app tool failed: ${JSON.stringify(result)}`);
  }
  const texts = result.contentItems.filter(item => item.type === 'inputText').map(item => item.text);
  if (texts.length === 1) {
    try { return JSON.parse(texts[0]); } catch { /* Plain text is also a valid tool result. */ }
  }
  return { text: texts.join('\n') };
}

export function projectPublishedReply(snapshot, threadId, hostId, filter) {
  if (typeof filter?.tag !== 'string' || !filter.tag.trim() || /[\r\n]/.test(filter.tag)) {
    throw new Error('Pass a nonempty single-line reply tag');
  }
  const polls = Array.isArray(snapshot?.polls) ? snapshot.polls.filter(poll => poll.thread?.id === threadId) : [];
  if (polls.length !== 1) throw new Error('Target reply snapshot unavailable');
  const poll = polls[0];
  if (!hostId || poll.thread.hostId !== hostId) throw new Error('Target reply host did not match');
  if (typeof poll.cursor !== 'string' || typeof poll.changed !== 'boolean') throw new Error('Invalid reply cursor snapshot');
  const result = { state: 'no-published-reply', cursor: poll.cursor, activeTurn: poll.latestTurn?.status === 'inProgress' };
  if (!poll.changed) return { ...result, state: 'no-new-reply' };
  const message = poll.latestAssistantMessage;
  if (!message) return result;
  if (typeof message.text !== 'string' || typeof message.id !== 'string' || !message.id ||
      typeof message.turnId !== 'string' || !message.turnId || message.truncated === true ||
      (message.phase !== undefined && !['commentary', 'final'].includes(message.phase)) ||
      message.text.split(/\r?\n/, 1)[0] !== filter.tag ||
      (filter.messageId && message.id !== filter.messageId) ||
      (filter.turnId && message.turnId !== filter.turnId)) return { ...result, state: 'reply-not-matched' };
  return { ...result, state: 'reply-visible', message: { id: message.id, turnId: message.turnId,
    ...(message.phase ? { phase: message.phase } : {}), text: message.text } };
}

function desktopPipeEndpoints() {
  if (process.platform !== 'win32') throw new Error('App-tool pipe discovery currently requires Windows');
  return fs.readdirSync('\\\\.\\pipe\\')
    .filter(name => /^codex-browser-use(?:-|[\\/])[0-9a-f-]{36}$/i.test(name))
    .map(name => '\\\\.\\pipe\\' + name);
}

export async function ensureCodexDesktop() {
  return ensureDesktopReady('codex', { probe: async () => {
    for (const endpoint of desktopPipeEndpoints()) {
      const pipe = new AppToolPipe(endpoint, { timeoutMs: 1000 });
      try {
        await pipe.connect();
        const catalog = await pipe.request('tools/list');
        if (['read_thread', 'send_message_to_thread'].every(name => catalog?.tools?.some(t => t.namespace === 'codex_app' && t.name === name))) return { endpoint };
      } catch { /* A stale endpoint is not ready. */ }
      finally { pipe.close(); }
    }
    return null;
  } });
}

export async function openAppTools(threadId, { timeoutMs = 15000, endpoints, callerThreadId = threadId, hostId, replyFilter, autoStart = true } = {}) {
  if (replyFilter && (!hostId || typeof replyFilter.tag !== 'string' || !replyFilter.tag.trim() || /[\r\n]/.test(replyFilter.tag))) {
    throw new Error('Reply-only reads require an exact host and a nonempty single-line reply tag');
  }
  if (!endpoints) {
    if (autoStart) await ensureCodexDesktop();
    endpoints = desktopPipeEndpoints();
  }
  const failures = [];
  // Only read-only probes may try multiple endpoints. Never replay a send.
  for (const endpoint of endpoints) {
    const pipe = new AppToolPipe(endpoint, { timeoutMs });
    try {
      await pipe.connect();
      const catalog = await pipe.request('tools/list');
      if (!(replyFilter ? ['wait_threads'] : ['read_thread', 'send_message_to_thread']).every(name =>
        catalog?.tools?.some(tool => tool.namespace === 'codex_app' && tool.name === name))) {
        throw new Error('Endpoint does not expose Codex thread tools');
      }
      if (replyFilter) {
        const raw = await pipe.request('tools/call', toolParams(callerThreadId, 'wait_threads', {
          targets: [{ threadId, hostId, ...(replyFilter.afterCursor ? { afterCursor: replyFilter.afterCursor } : {}) }], timeoutMs: 0,
        }));
        let snapshot;
        try { snapshot = decodeToolResult(raw); } catch { throw new Error('Reply snapshot decode failed'); }
        const reply = projectPublishedReply(snapshot, threadId, hostId, replyFilter);
        return { pipe, reply };
      }
      const state = decodeToolResult(await pipe.request('tools/call', toolParams(callerThreadId,
        'read_thread', { threadId, ...(hostId ? { hostId } : {}), turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 })));
      if (state.thread?.id !== threadId) throw new Error('Target thread readback did not match');
      if (hostId && state.thread?.hostId !== hostId) throw new Error('Target thread host did not match');
      return { pipe, state };
    } catch (error) {
      pipe.close();
      failures.push({ endpoint, error: error.message });
    }
  }
  throw new Error(`No ready Codex app tool endpoint: ${JSON.stringify(failures)}`);
}

export function loadPrompt(args) {
  if (args['prompt-file'] && args.prompt) throw new Error('Use either --prompt-file or --prompt');
  const text = args['prompt-file']
    ? fs.readFileSync(args['prompt-file'], 'utf8').replace(/^\uFEFF/, '')
    : args.prompt || args._.slice(1).join(' ');
  if (typeof text !== 'string' || !text.trim()) throw new Error('No prompt text');
  return text;
}
