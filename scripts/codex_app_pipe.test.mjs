import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AppToolPipe, encodeFrame, toolParams, decodeToolResult, openAppTools, loadPrompt, projectPublishedReply } from './codex_app_pipe.mjs';

async function server(t, onRequest) {
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\claude-codex-test-${randomUUID()}`
    : path.join(os.tmpdir(), `claude-codex-${randomUUID()}.sock`);
  const sockets = new Set();
  const listener = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        onRequest(request, socket);
      }
    });
  });
  await new Promise(resolve => listener.listen(endpoint, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); listener.close(); });
  return endpoint;
}

test('native request uses required callerSource and preserves exact Unicode payload and target', () => {
  const prompt = '클로드 → Codex\n"직접 전달" $x `value` 😀';
  const params = toolParams('target', 'send_message_to_thread', { threadId: 'target', prompt }, 'stable-call');
  assert.equal(params.callerSource, 'codex');
  assert.equal(params.threadId, 'target');
  assert.equal(params.arguments.prompt, prompt);
  assert.equal(params.callId, 'stable-call');
  assert.equal(params.arguments.model, undefined);
  const frame = encodeFrame(params);
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4)), params);
});

test('prompt-file reads exact UTF-8 and rejects conflicting inputs', () => {
  const fixture = fileURLToPath(import.meta.url);
  assert.equal(loadPrompt({ 'prompt-file': fixture, _: ['send'] }), fs.readFileSync(fixture, 'utf8'));
  assert.throws(() => loadPrompt({ 'prompt-file': fixture, prompt: 'conflict' }));
  assert.throws(() => loadPrompt({ _: ['send'], prompt: '  ' }));
});

test('CLI refuses implicit latest-thread delivery before connecting', () => {
  const cli = fileURLToPath(new URL('./codex_bridge.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'send', '--prompt', 'do not deliver'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(JSON.parse(result.stdout).error, /exact thread ID/);
});

test('catalog alone is insufficient; wrong target rejected, ready target selected, fragmented frames decoded', async t => {
  let sends = 0;
  const endpoint = await server(t, (request, socket) => {
    if (request.method === 'tools/call') assert.equal(request.params.callerSource, 'codex');
    let result;
    if (request.method === 'tools/list') result = { tools: ['read_thread', 'send_message_to_thread'].map(name => ({ name, namespace: 'codex_app' })) };
    else if (request.params.tool === 'read_thread') result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ thread: { id: 'target' } }) }] };
    else { sends++; result = { success: true, contentItems: [{ type: 'inputText', text: '{"status":"queued"}' }] }; }
    const bytes = encodeFrame({ jsonrpc: '2.0', id: request.id, result });
    socket.write(bytes.subarray(0, 2));
    setImmediate(() => socket.write(bytes.subarray(2)));
  });
  await assert.rejects(openAppTools('wrong', { endpoints: [endpoint] }), /did not match/);
  const { pipe } = await openAppTools('target', { endpoints: [endpoint] });
  t.after(() => pipe.close());
  assert.equal(sends, 0);
  const result = decodeToolResult(await pipe.request('tools/call', toolParams('target', 'send_message_to_thread', { threadId: 'target', prompt: '한글' }), { mutation: true }));
  assert.equal(result.status, 'queued');
  assert.equal(sends, 1);
});

test('lost mutation acknowledgement is unknown and never retried', async t => {
  let count = 0;
  const endpoint = await server(t, (_request, socket) => { count++; socket.destroy(); });
  const pipe = await new AppToolPipe(endpoint).connect();
  t.after(() => pipe.close());
  await assert.rejects(pipe.request('tools/call', { test: true }, { mutation: true }), error => error.delivery === 'unknown');
  assert.equal(count, 1);
});

test('cloud destination uses an explicit local caller context and verifies the destination host', async t => {
  const calls = [];
  const endpoint = await server(t, (request, socket) => {
    let result;
    if (request.method === 'tools/list') {
      result = { tools: ['read_thread', 'send_message_to_thread'].map(name => ({ name, namespace: 'codex_app' })) };
    } else {
      calls.push(request.params);
      if (request.params.threadId !== 'local-caller') {
        socket.write(encodeFrame({ jsonrpc: '2.0', id: request.id, error: { message: 'Caller context must be local' } }));
        return;
      }
      result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ thread: { id: 'cloud-target', hostId: 'durable' } }) }] };
    }
    socket.write(encodeFrame({ jsonrpc: '2.0', id: request.id, result }));
  });
  await assert.rejects(openAppTools('cloud-target', { endpoints: [endpoint] }), /Caller context must be local/);
  const ready = await openAppTools('cloud-target', { endpoints: [endpoint], callerThreadId: 'local-caller', hostId: 'durable' });
  ready.pipe.close();
  assert.equal(ready.state.thread.id, 'cloud-target');
  assert.equal(calls.at(-1).threadId, 'local-caller');
  assert.equal(calls.at(-1).arguments.threadId, 'cloud-target');
  assert.equal(calls.at(-1).arguments.hostId, 'durable');
  await assert.rejects(openAppTools('cloud-target', { endpoints: [endpoint], callerThreadId: 'local-caller', hostId: 'wrong-host' }), /host did not match/);
  assert.ok(calls.every(call => call.tool === 'read_thread'));
});

test('timeout and tool failure cannot become send success', async t => {
  const endpoint = await server(t, () => {});
  const pipe = await new AppToolPipe(endpoint).connect();
  t.after(() => pipe.close());
  await assert.rejects(pipe.request('tools/call', {}, { mutation: true, timeoutMs: 20 }), error => error.delivery === 'unknown');
  assert.throws(() => decodeToolResult({ success: false, contentItems: [] }), /failed/);
});

const replyTag = '[dot-to-Claude request-1]';
function replySnapshot() {
  return { polls: [{ thread: { id: 'cloud-target', hostId: 'durable' }, cursor: 'generation:2', changed: true,
    latestTurn: { id: 'turn-1', status: 'inProgress' },
    latestAssistantMessage: { id: 'message-1', turnId: 'turn-1', phase: 'commentary', text: `${replyTag}\nPublic technical reply` },
    latestToolMarker: { input: 'private tool input' }, history: 'private history' }] };
}

test('published reply exposes only a tagged assistant message during an active turn', () => {
  const result = projectPublishedReply(replySnapshot(), 'cloud-target', 'durable', { tag: replyTag });
  assert.deepEqual(result, { state: 'reply-visible', cursor: 'generation:2', activeTurn: true,
    message: { id: 'message-1', turnId: 'turn-1', phase: 'commentary', text: `${replyTag}\nPublic technical reply` } });
  assert.doesNotMatch(JSON.stringify(result), /private|latestToolMarker|history/);
});

test('unpublished, mismatched and unchanged replies do not expose any text', () => {
  for (const change of [
    poll => { poll.latestAssistantMessage.text = 'private commentary'; },
    poll => { poll.latestAssistantMessage.phase = 'analysis'; },
    poll => { poll.latestAssistantMessage.text = `${replyTag} extra\nprivate commentary`; },
    poll => { poll.latestAssistantMessage = null; },
    poll => { poll.changed = false; },
    poll => { poll.latestAssistantMessage.truncated = true; },
  ]) {
    const snapshot = replySnapshot(); change(snapshot.polls[0]);
    const result = projectPublishedReply(snapshot, 'cloud-target', 'durable', { tag: replyTag });
    assert.equal(result.message, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private|Public technical reply/);
  }
  for (const filter of [{ messageId: 'different' }, { turnId: 'different' }]) {
    assert.equal(projectPublishedReply(replySnapshot(), 'cloud-target', 'durable', { tag: replyTag, ...filter }).message, undefined);
  }
});

test('reply-only reads pin target and host and reject malformed responses without leaking payloads', () => {
  assert.throws(() => projectPublishedReply(replySnapshot(), 'other', 'durable', { tag: replyTag }), /Target reply snapshot unavailable/);
  assert.throws(() => projectPublishedReply(replySnapshot(), 'cloud-target', 'wrong', { tag: replyTag }), /host did not match/);
  assert.throws(() => projectPublishedReply({ errors: [{ threadId: 'cloud-target', message: 'private error' }] }, 'cloud-target', 'durable', { tag: replyTag }), /Target reply snapshot unavailable/);
  assert.throws(() => projectPublishedReply(replySnapshot(), 'cloud-target', 'durable', { tag: '' }), /single-line reply tag/);
});

test('reply-only endpoint selection calls wait once with cursor and never reads history or sends', async t => {
  const calls = [];
  const endpoint = await server(t, (request, socket) => {
    if (request.method === 'tools/list') {
      socket.write(encodeFrame({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'wait_threads', namespace: 'codex_app' }] } }));
      return;
    }
    calls.push(request.params);
    socket.write(encodeFrame({ jsonrpc: '2.0', id: request.id, result: { success: true,
      contentItems: [{ type: 'inputText', text: JSON.stringify(replySnapshot()) }] } }));
  });
  const ready = await openAppTools('cloud-target', { endpoints: [endpoint], callerThreadId: 'local-caller', hostId: 'durable',
    replyFilter: { tag: replyTag, afterCursor: 'generation:1', messageId: 'message-1', turnId: 'turn-1' } });
  ready.pipe.close();
  assert.equal(ready.reply.state, 'reply-visible');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadId, 'local-caller');
  assert.equal(calls[0].tool, 'wait_threads');
  assert.deepEqual(calls[0].arguments, { targets: [{ threadId: 'cloud-target', hostId: 'durable', afterCursor: 'generation:1' }], timeoutMs: 0 });
});
