#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { evaluateDesktop } from './desktop_rpc.mjs';
import { loadPrompt } from './codex_app_pipe.mjs';
import { reservePeerMessage, markPeerMessage, findPeerMessageRecord } from './claude_peer_transport.mjs';

export async function discoverAntigravity(profile = path.join(process.env.APPDATA || '', 'Antigravity')) {
  const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Antigravity desktop port');
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  const candidates = targets.filter(t => t.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(t.url) && /Antigravity$/.test(t.title));
  if (candidates.length !== 1) throw new Error(`Expected one Antigravity desktop surface; found ${candidates.length}`);
  const target = candidates[0];
  const identity = await evaluateDesktop(target.webSocketDebuggerUrl, '({native:typeof window.nativeStorage?.getItems === "function", product:window.__APP_CONFIG__?.productName, version:window.__APP_CONFIG__?.appVersion})');
  if (!identity.native || !/antigravity/i.test(identity.product || '')) throw new Error('Endpoint is not the Antigravity desktop app');
  return { ...target, version: identity.version };
}

// Runs inside the existing desktop renderer, using its authenticated native client.
// Names are discovered from runtime descriptors rather than minified bundle names.
export async function antigravityAction(input) {
  const globals = Object.values(window);
  const service = globals.find(v => v?.kind === 'service' && v.typeName === 'exa.language_server_pb.LanguageServerService');
  const client = globals.find(v => v?.lsClient && typeof v.lsClient.startCascade === 'function')?.lsClient;
  if (!service || !client) throw new Error('Antigravity desktop session client unavailable');
  const factories = globals.filter(v => typeof v === 'function' && /\$typeName\s*=/.test(Function.prototype.toString.call(v)) && /Object\.create/.test(Function.prototype.toString.call(v)) && /fieldKind/.test(Function.prototype.toString.call(v)));
  if (factories.length !== 1) throw new Error('Native protobuf message constructor unavailable or ambiguous');
  const message = factories[0];
  const call = async (name, request) => {
    const method = service.methods.find(m => m.localName === name);
    if (!method || typeof client[name] !== 'function') throw new Error(`Native method unavailable: ${name}`);
    for (const key of Object.keys(request)) if (!method.input.fields.some(f => f.localName === key)) throw new Error(`Native request field unavailable: ${name}.${key}`);
    return client[name](message(method.input, request));
  };
  const first = async name => {
    const controller = new AbortController();
    try { return (await client[name]({}, { signal: controller.signal, timeoutMs: 10000 })[Symbol.asyncIterator]().next()).value; }
    finally { controller.abort(); }
  };
  const summaries = async () => (await first('jetboxSubscribeToSummaries'))?.updates || {};
  const project = s => s.trajectoryMetadata?.projectId;
  const sessionRow = (id, s) => ({ app: 'antigravity', sessionId: id, title: s.annotations?.title || s.summary, status: s.status,
    projectId: project(s), workspaceUris: s.trajectoryMetadata?.workspaceUris || s.workspaces?.map(w => w.workspaceUri) || [], stepCount: s.stepCount });
  const enumValue = (method, field, suffix) => {
    const value = service.methods.find(m => m.localName === method)?.input.fields.find(f => f.localName === field)?.enum?.values.find(v => v.name.endsWith(suffix));
    if (!value) throw new Error(`Native enum unavailable: ${method}.${field}.${suffix}`);
    return value.number;
  };
  const read = async id => {
    const r = await call('getCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 2 });
    if (!r.trajectory || r.trajectory.cascadeId !== id) throw new Error('Antigravity session readback did not match');
    while (r.trajectory.steps.length < r.numTotalSteps) {
      const more = await call('getCascadeTrajectorySteps', { cascadeId: id, trajectoryVerbosity: 2, stepOffset: r.trajectory.steps.length });
      if (!more.steps?.length) throw new Error('Antigravity transcript page missing');
      r.trajectory.steps.push(...more.steps);
    }
    return r;
  };
  if (input.command === 'status' || input.command === 'list') {
    const rows = Object.entries(await summaries()).map(([id, s]) => sessionRow(id, s));
    return { ok: true, app: 'antigravity', version: window.__APP_CONFIG__.appVersion, sessions: rows.filter(s => !input.workspaceUri || s.workspaceUris.some(u => u.toLowerCase() === input.workspaceUri.toLowerCase())) };
  }
  if (input.command === 'create') {
    if (!input.workspaceUri || !input.sessionId) throw new Error('Create requires a workspace and fresh session ID');
    let projectId = input.projectId;
    if (input.projectName) {
      const update = await first('projectUpdatesStream');
      const ids = update?.update?.case === 'projectList' ? update.update.value.projectIds : undefined;
      if (!ids) throw new Error('Antigravity project list unavailable');
      const projects = (await call('readProjects', { ids })).projects || [];
      const matching = projects.filter(p => p.projectResources?.resources.some(r => r.type?.case === 'folderUri' && r.type.value.toLowerCase() === input.workspaceUri.toLowerCase()));
      if (matching.length > 1) throw new Error('Multiple Antigravity projects use this folder; pass an exact --project-id');
      if (matching.length === 1) projectId = matching[0].id;
      else {
        projectId = input.newProjectId;
        await call('createProject', { project: { id: projectId, name: input.projectName, isWorkspaceOnly: true,
          projectResources: { resources: [{ type: { case: 'folderUri', value: input.workspaceUri } }] } } });
      }
    }
    const result = await call('startCascade', { cascadeId: input.sessionId, ...(projectId ? {} : { workspaceUris: [input.workspaceUri] }),
      ...(projectId ? { projectEnvConfig: { projectId, target: { case: 'defaultProjectEnvironment', value: {} } } } : {}),
      source: enumValue('startCascade', 'source', '_JETBOX'), trajectoryType: enumValue('startCascade', 'trajectoryType', '_CASCADE') });
    if (result.cascadeId !== input.sessionId) throw new Error('Created session ID did not match');
    if (input.title) await call('updateConversationAnnotations', { cascadeId: input.sessionId, annotations: { title: input.title }, mergeAnnotations: true });
    const state = await read(input.sessionId);
    return { ok: true, app: 'antigravity', sessionId: input.sessionId, projectId: state.trajectory.metadata?.projectId,
      workspaceUris: state.trajectory.metadata?.workspaceUris, delivery: 'desktop-session-created' };
  }
  if (!input.sessionId) throw new Error('An exact --session-id is required');
  const state = await read(input.sessionId);
  if (input.command === 'read') {
    const entries = state.trajectory.steps.map((s, index) => {
      const kind = s.step?.case;
      const v = s.step?.value;
      const text = kind === 'userInput' ? (v.items || []).map(i => i.chunk?.case === 'text' ? i.chunk.value : '').join('') :
        kind === 'plannerResponse' ? v.response : kind === 'notifyUser' ? v.notificationContent : kind === 'errorMessage' ? v.message : undefined;
      return { index, id: s.stepId, kind, status: s.status, ...(kind === 'userInput' ? { tags: v.tags || [] } : {}), ...(text ? { text } : {}) };
    });
    return { ok: true, app: 'antigravity', sessionId: input.sessionId, status: state.status, totalSteps: state.numTotalSteps,
      workspaceUris: state.trajectory.metadata?.workspaceUris, projectId: state.trajectory.metadata?.projectId,
      entries: entries.slice(input.afterStep ?? Math.max(0, entries.length - (input.lines || 20))) };
  }
  if (input.command === 'set-permission-mode') {
    const projectId = state.trajectory.metadata?.projectId;
    if (!projectId) throw new Error('This conversation has no project; Antigravity permission presets require a project');
    if (input.scope !== undefined && input.scope !== 'project') throw new Error('Antigravity permission scope must be project');
    const p = (await call('readProject', { id: projectId })).project;
    if (!p || p.id !== projectId) throw new Error('Permission target project did not match');
    const settingsSchema = service.methods.find(m => m.localName === 'updateProject').input.fields.find(f => f.localName === 'project').message.fields.find(f => f.localName === 'settings').message;
    const settingEnum = (field, suffix) => {
      const value = settingsSchema.fields.find(f => f.localName === field)?.enum?.values.find(v => v.name.endsWith(suffix));
      if (!value) throw new Error(`Native project setting unavailable: ${field}.${suffix}`);
      return value.number;
    };
    const modes = { 'always-proceed': { sandboxMode: false, autoExecutionPolicy: settingEnum('autoExecutionPolicy', '_EAGER'), fileAccessPolicy: settingEnum('fileAccessPolicy', '_ALLOW'),
      internetPolicy: settingEnum('internetPolicy', '_ALLOW'), artifactReviewMode: settingEnum('artifactReviewMode', '_TURBO'), permissionPreset: settingEnum('permissionPreset', '_TURBO') },
      'request-review': { sandboxMode: false, autoExecutionPolicy: settingEnum('autoExecutionPolicy', '_OFF'), fileAccessPolicy: settingEnum('fileAccessPolicy', '_ASK'),
        internetPolicy: settingEnum('internetPolicy', '_ASK'), artifactReviewMode: settingEnum('artifactReviewMode', '_ALWAYS'), permissionPreset: settingEnum('permissionPreset', '_REQUEST_REVIEW') } };
    if (!modes[input.mode]) throw new Error('Mode must be always-proceed or request-review');
    await call('updateProject', { project: { ...p, settings: message(settingsSchema, { ...p.settings, ...modes[input.mode] }) } });
    const actual = (await call('readProject', { id: projectId })).project;
    if (Object.entries(modes[input.mode]).some(([k, v]) => actual?.settings?.[k] !== v)) throw new Error('Permission readback did not match');
    return { ok: true, sessionId: input.sessionId, projectId, scope: 'project', mode: input.mode, settings: modes[input.mode] };
  }
  if (input.command !== 'send') throw new Error('Unknown Antigravity command');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('Prompt must not be empty');
  let config;
  if (input.model) {
    const models = (await call('getCascadeModelConfigData', {})).clientModelConfigs;
    const selected = models.filter(m => m.modelId === input.model || m.label === input.model);
    if (selected.length !== 1 || selected[0].disabled) throw new Error('Requested model unavailable');
    config = { plannerConfig: { requestedModel: selected[0].modelOrAlias } };
  } else {
    const previous = state.trajectory.steps.findLast(s => s.step?.case === 'userInput')?.step.value.userConfig;
    if (previous) config = previous;
    else {
      const appState = (await first('jetboxSubscribeToState'))?.appState;
      const models = await call('getCascadeModelConfigData', {});
      const selected = appState?.lastSelectedAgentModel;
      const model = typeof selected === 'number' ? { choice: { case: 'model', value: selected } } : selected || models.defaultOverrideModelConfig?.modelOrAlias;
      if (model) config = { plannerConfig: { requestedModel: model } };
    }
  }
  await call('sendUserCascadeMessage', { cascadeId: input.sessionId, items: [{ chunk: { case: 'text', value: input.prompt } }],
    ...(config ? { cascadeConfig: config } : {}), ...(input.requestId ? { tags: [`desktop-bridge:${input.requestId}`] } : {}), propagateError: true });
  return { ok: true, app: 'antigravity', sessionId: input.sessionId, requestId: input.requestId, afterStep: state.numTotalSteps, delivery: 'app-acknowledged' };
}

export async function runAntigravity(input, options = {}) {
  const target = await discoverAntigravity(options.profile);
  let reservation;
  if (input.command === 'send') {
    if (!input.sessionId || typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('Send requires an exact session and nonempty prompt');
    reservation = await reservePeerMessage({ sessionId: `antigravity:${input.sessionId}` }, input.prompt);
    input = { ...input, requestId: reservation.messageId };
  }
  try {
    const result = await evaluateDesktop(target.webSocketDebuggerUrl, `(${antigravityAction.toString()})(${JSON.stringify(input)})`,
      { timeoutMs: options.timeoutMs || 30000, mutation: ['create', 'send', 'set-permission-mode'].includes(input.command) });
    if (reservation) {
      await markPeerMessage(reservation.recordPath, reservation.messageId, 'written-unconfirmed');
      result.outboxPath = reservation.recordPath;
    }
    return result;
  } catch (error) {
    if (reservation) {
      await markPeerMessage(reservation.recordPath, reservation.messageId, 'unknown');
      error.requestId = reservation.messageId;
      error.sessionId = input.sessionId;
    }
    throw error;
  }
}

export function selectAntigravityReceipt(receipt, requestId) {
  const own = receipt.entries.findIndex(e => e.kind === 'userInput' && e.tags?.includes(`desktop-bridge:${requestId}`));
  const next = own < 0 ? -1 : receipt.entries.findIndex((e, i) => i > own && e.kind === 'userInput');
  const entries = own < 0 ? [] : receipt.entries.slice(own, next < 0 ? undefined : next);
  const completed = (receipt.status === 1 || next >= 0) && entries.some(e => e.kind === 'plannerResponse' && e.status === 3 && e.text);
  return { ...receipt, entries, requestId, delivery: completed ? 'reply-complete' : own >= 0 ? 'awaiting-reply' : 'unknown' };
}

async function main() {
  const args = { _: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1]?.startsWith('--') || !argv[i + 1] ? true : argv[++i]; else args._.push(a); }
  const command = args._[0] || 'status';
  if (args.help) { console.log('Antigravity desktop: status | list [--cwd PATH] | create --cwd PATH [--title TEXT] [--prompt-file PATH] [--mode always-proceed|request-review] [--project-id ID] | send --session-id ID --prompt-file PATH [--wait] | read --session-id ID [--after-step N] [--request-id UUID] | set-permission-mode --session-id ID --mode always-proceed|request-review (project permissions)'); return; }
  if (args.mode && !['always-proceed', 'request-review'].includes(args.mode)) throw new Error('Mode must be always-proceed or request-review');
  if (args.scope !== undefined && args.scope !== 'project') throw new Error('Antigravity permission scope must be project');
  const input = { command, sessionId: args['session-id'], title: args.title, mode: args.mode, scope: args.scope, model: args.model,
    lines: Number(args.lines || 20), ...(args['after-step'] !== undefined ? { afterStep: Number(args['after-step']) } : {}),
    ...(args.cwd ? { workspaceUri: pathToFileURL(path.resolve(args.cwd)).href } : {}) };
  if (command === 'create') {
    if (!args.cwd) throw new Error('Create requires --cwd');
    if (!fs.statSync(path.resolve(args.cwd)).isDirectory()) throw new Error('Create requires an existing project directory');
    input.sessionId = randomUUID();
    if (args['project-id']) input.projectId = args['project-id'];
    else if (args.mode || args.project) { input.projectName = args.project || path.basename(path.resolve(args.cwd)); input.newProjectId = randomUUID(); }
  }
  const prompt = command === 'send' || command === 'create' && (args.prompt || args['prompt-file']) ? loadPrompt(args) : undefined;
  let result = await runAntigravity({ ...input, ...(command === 'send' ? { prompt } : {}),
    ...(command === 'read' && args['request-id'] ? { afterStep: 0 } : {}) }).catch(error => {
      if (command === 'create') { error.sessionId = input.sessionId; error.projectId = input.projectId || input.newProjectId; }
      throw error;
    });
  if (command === 'create') {
    console.log(JSON.stringify(result)); // Preserve the created identity even if the initial send fails.
    if (args.mode) console.log(JSON.stringify(await runAntigravity({ command: 'set-permission-mode', sessionId: input.sessionId, scope: args.scope, mode: args.mode })));
    if (prompt) result = await runAntigravity({ command: 'send', sessionId: input.sessionId, prompt, model: args.model });
  }
  if (command === 'read' && args['request-id']) {
    result = selectAntigravityReceipt(result, args['request-id']);
    let record;
    try { record = findPeerMessageRecord(`antigravity:${input.sessionId}`, args['request-id']); }
    catch (error) { if (!error.message.startsWith('No outbox request matches')) throw error; }
    if (record && result.entries.length) await markPeerMessage(record.recordPath, args['request-id'], result.delivery === 'reply-complete' ? 'confirmed' : 'transcript-confirmed-awaiting-reply');
  }
  if (args.wait && result.afterStep !== undefined) {
    const deadline = Date.now() + Number(args['timeout-ms'] || 120000);
    let receipt;
    do {
      receipt = selectAntigravityReceipt(await runAntigravity({ command: 'read', sessionId: input.sessionId, afterStep: result.afterStep }), result.requestId);
      if (receipt.entries.some(e => e.kind === 'errorMessage')) throw Object.assign(new Error('Antigravity returned an error step'), { receipt });
      if (receipt.delivery === 'reply-complete') break;
      await new Promise(r => setTimeout(r, 500));
    } while (Date.now() < deadline);
    if (receipt.entries.length) await markPeerMessage(result.outboxPath, result.requestId, receipt.delivery === 'reply-complete' ? 'confirmed' : 'transcript-confirmed-awaiting-reply');
    result = { ...result, receipt, delivery: receipt.delivery };
  }
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => { console.log(JSON.stringify({ ok: false, error: e.message, delivery: e.delivery || e.details?.delivery, sessionId: e.sessionId, projectId: e.projectId, requestId: e.requestId || e.details?.messageId, receipt: e.receipt })); process.exitCode = 1; });
