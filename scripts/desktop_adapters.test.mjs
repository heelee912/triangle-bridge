import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravityAction, selectAntigravityReceipt } from './antigravity_bridge.mjs';
import { installSkills } from './install_skills.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVisibleUserFrame, chooseDesktopSendTransport } from './claude_visible_transport.mjs';
import { permissionSettings, setDesktopPermissions } from './codex_desktop_settings.mjs';
import { ensureDesktopReady } from './desktop_lifecycle.mjs';

for (const app of ['codex', 'claude', 'antigravity']) {
  test(`${app} reuses a ready desktop app without launching it`, async () => {
    const running = { pids: [1234] };
    const result = await ensureDesktopReady(app, { probe: async () => running,
      launch: async () => assert.fail('Ready apps must never be launched or restarted') });
    assert.equal(result.started, false);
    assert.equal(result.ready, running);
  });
  test(`${app} starts once and waits for readiness before returning`, async () => {
    let probes = 0, launches = 0;
    const events = [];
    const result = await ensureDesktopReady(app, { intervalMs: 0,
      probe: async () => { events.push('probe'); return ++probes < 3 ? null : { pids: [4321] }; },
      launch: async target => { assert.equal(target, app); launches++; events.push('launch'); return { action: 'launch' }; } });
    assert.equal(launches, 1);
    assert.equal(result.started, true);
    assert.deepEqual(events, ['probe', 'launch', 'probe', 'probe']);
  });
}

test('desktop startup times out without relaunching or replaying a session mutation', async () => {
  let clock = 0, launches = 0;
  await assert.rejects(ensureDesktopReady('antigravity', { timeoutMs: 10, intervalMs: 5, now: () => clock,
    sleep: async ms => { clock += ms; }, probe: async () => { throw new Error('native client unavailable'); },
    launch: async () => { launches++; } }), /did not become ready.*native client unavailable/);
  assert.equal(launches, 1);
});

test('a different or ambiguous desktop identity never triggers a launch', async () => {
  await assert.rejects(ensureDesktopReady('antigravity', {
    probe: async () => { throw Object.assign(new Error('wrong desktop'), { desktopIdentityMismatch: true }); },
    launch: async () => assert.fail('Identity mismatch must not trigger startup'),
  }), /wrong desktop/);
});

test('Claude ordinary input preserves Unicode and the receipt UUID without hidden meta fields', () => {
  const frame = JSON.parse(buildVisibleUserFrame('exact-session', '주인님\n화면 표시 테스트', 'request-uuid'));
  assert.equal(frame.uuid, 'request-uuid');
  assert.equal(frame.session_id, 'exact-session');
  assert.equal(frame.message.content, '주인님\n화면 표시 테스트');
  assert.equal(frame.message.role, 'user');
  assert.equal(Object.hasOwn(frame, 'isMeta'), false);
  assert.equal(Object.hasOwn(frame, 'origin'), false);
  assert.equal(chooseDesktopSendTransport('code'), 'live-stdin');
  assert.equal(chooseDesktopSendTransport('cowork'), null);
});

function antigravityFixture() {
  const calls = [];
  const field = (localName, extra = {}) => ({ localName, ...extra });
  const enumeration = (names) => ({ values: names.map(([name, number]) => ({ name, number })) });
  const settingsSchema = { typeName: 'Settings', fields: [
    field('sandboxMode'), field('securityPlugins'),
    field('fileAccessPolicy', { enum: enumeration([['POLICY_ALLOW', 1], ['POLICY_ASK', 2]]) }),
    field('internetPolicy', { enum: enumeration([['INTERNET_ALLOW', 1], ['INTERNET_ASK', 2]]) }),
    field('artifactReviewMode', { enum: enumeration([['REVIEW_TURBO', 2], ['REVIEW_ALWAYS', 1]]) }),
    field('autoExecutionPolicy', { enum: enumeration([['EXEC_EAGER', 3], ['EXEC_OFF', 1]]) }),
    field('permissionPreset', { enum: enumeration([['PRESET_TURBO', 3], ['PRESET_REQUEST_REVIEW', 2]]) }),
  ] };
  const projectSchema = { typeName: 'Project', fields: [field('id'), field('settings', { message: settingsSchema })] };
  const definitions = {
    getCascadeTrajectory: [field('cascadeId'), field('trajectoryVerbosity')],
    readProjects: [field('ids')], readProject: [field('id')],
    updateProject: [field('project', { message: projectSchema })],
    startCascade: [field('cascadeId'), field('workspaceUris'), field('projectEnvConfig'),
      field('source', { enum: enumeration([['SOURCE_JETBOX', 18]]) }),
      field('trajectoryType', { enum: enumeration([['TYPE_CASCADE', 4]]) })],
    sendUserCascadeMessage: ['cascadeId', 'items', 'cascadeConfig', 'tags', 'propagateError'].map(n => field(n)),
    getCascadeModelConfigData: [],
  };
  const service = { kind: 'service', typeName: 'exa.language_server_pb.LanguageServerService',
    methods: Object.entries(definitions).map(([localName, fields]) => ({ localName, input: { typeName: localName, fields } })) };
  // The native constructor returns already typed objects unchanged. This reproduces
  // the settings serialization bug when spreading an existing typed Project.
  const message = function(schema, value) {
    if (value?.$typeName === schema.typeName) return value;
    const result = Object.create(null);
    result.$typeName = schema.typeName;
    const fieldKind = schema.fields;
    for (const f of fieldKind) if (value?.[f.localName] !== undefined) result[f.localName] =
      f.message ? message(f.message, value[f.localName]) : value[f.localName];
    return result;
  };
  let p = { $typeName: 'Project', id: 'project-exact', projectResources: { resources: [{ type: { case: 'folderUri', value: 'file:///C:/project' } }] },
    settings: { $typeName: 'Settings', securityPlugins: { preserved: true } } };
  const stream = value => async function* () { yield value; };
  const client = {
    projectUpdatesStream: stream({ update: { case: 'projectList', value: { projectIds: ['project-exact'] } } }),
    jetboxSubscribeToState: stream({ appState: { lastSelectedAgentModel: 1318 } }),
  };
  for (const name of Object.keys(definitions)) client[name] = async request => {
    calls.push({ name, request });
    if (name === 'getCascadeTrajectory') return { status: 1, numTotalSteps: 0, trajectory: { cascadeId: request.cascadeId, metadata: { projectId: 'project-exact' }, steps: [] } };
    if (name === 'readProjects') { assert.deepEqual(request.ids, ['project-exact']); return { projects: [p] }; }
    if (name === 'readProject') return { project: p };
    if (name === 'updateProject') { assert.equal(request.project.settings.$typeName, 'Settings'); p = request.project; return {}; }
    if (name === 'startCascade') return { cascadeId: request.cascadeId };
    if (name === 'getCascadeModelConfigData') return {};
    return {};
  };
  return { window: { service, app: { lsClient: client }, message, __APP_CONFIG__: { appVersion: 'test' } }, calls };
}

test('Antigravity creation reads real project IDs and uses the exclusive project target', async () => {
  const fixture = antigravityFixture();
  globalThis.window = fixture.window;
  try {
    const created = await antigravityAction({ command: 'create', sessionId: 'fresh-exact', workspaceUri: 'file:///C:/project', projectName: 'project' });
    assert.equal(created.sessionId, 'fresh-exact');
    const request = fixture.calls.find(c => c.name === 'startCascade').request;
    assert.equal(request.projectEnvConfig.projectId, 'project-exact');
    assert.equal(Object.hasOwn(request, 'workspaceUris'), false);
    assert.equal(request.source, 18);
  } finally { delete globalThis.window; }
});

test('Antigravity rebuilds typed settings and reads back project permissions', async () => {
  const fixture = antigravityFixture();
  globalThis.window = fixture.window;
  try {
    await assert.rejects(antigravityAction({ command: 'set-permission-mode', sessionId: 'exact', scope: 'session', mode: 'always-proceed' }), /scope must be project/);
    assert.equal(fixture.calls.some(c => c.name === 'updateProject'), false);
    const result = await antigravityAction({ command: 'set-permission-mode', sessionId: 'exact', mode: 'always-proceed' });
    assert.equal(result.scope, 'project');
    assert.deepEqual(result.settings, { sandboxMode: false, autoExecutionPolicy: 3, fileAccessPolicy: 1, internetPolicy: 1, artifactReviewMode: 2, permissionPreset: 3 });
    assert.deepEqual(fixture.calls.find(c => c.name === 'updateProject').request.project.settings.securityPlugins, { preserved: true });
    const review = await antigravityAction({ command: 'set-permission-mode', sessionId: 'exact', mode: 'request-review' });
    assert.deepEqual(review.settings, { sandboxMode: false, autoExecutionPolicy: 1, fileAccessPolicy: 2, internetPolicy: 2, artifactReviewMode: 1, permissionPreset: 2 });
  } finally { delete globalThis.window; }
});

test('Antigravity selected numeric model is serialized as a native union with a request tag', async () => {
  const fixture = antigravityFixture();
  globalThis.window = fixture.window;
  try {
    await antigravityAction({ command: 'send', sessionId: 'exact', prompt: '표시', requestId: 'uuid' });
    const request = fixture.calls.find(c => c.name === 'sendUserCascadeMessage').request;
    assert.deepEqual(request.cascadeConfig.plannerConfig.requestedModel, { choice: { case: 'model', value: 1318 } });
    assert.deepEqual(request.tags, ['desktop-bridge:uuid']);
    assert.equal(request.cascadeId, 'exact');
  } finally { delete globalThis.window; }
});

test('Codex permission mutation preserves model and verifies the exact target readback', async () => {
  let listener;
  let settings = { model: 'current-model', effort: 'high', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } };
  const bus = {
    onEvent(fn) { listener = fn; return () => {}; }, broadcast() {},
    async request(method, params) {
      assert.equal(params.conversationId, 'exact');
      if (method === 'thread-follower-update-thread-settings') { settings = { ...settings, ...params.threadSettings }; return { resultType: 'success', result: { applied: true } }; }
      listener({ method: 'thread-stream-state-changed', params: { conversationId: 'exact', hostId: 'local', change: { type: 'snapshot', conversationState: { latestThreadSettings: settings } } } });
      return { resultType: 'success' };
    },
  };
  const result = await setDesktopPermissions(bus, 'exact', 'always-proceed', 'local');
  assert.equal(result.model, 'current-model');
  assert.equal(result.approvalPolicy, 'never');
  assert.equal(result.sandboxPolicy.type, 'dangerFullAccess');
  assert.throws(() => permissionSettings('invalid'), /Mode must/);
});

test('Antigravity receipt excludes later human inputs and unrelated assistant responses', () => {
  const input = { kind: 'userInput', tags: ['desktop-bridge:own'] };
  const result = selectAntigravityReceipt({ status: 1, entries: [input, { kind: 'userInput', tags: ['other'] },
    { kind: 'plannerResponse', text: 'unrelated', status: 3 }] }, 'own');
  assert.deepEqual(result.entries, [input]);
  assert.equal(result.delivery, 'awaiting-reply');
});

test('skill installation copies all runtime dependencies to arbitrary homes and preserves unrelated files', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triangle-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const custom = path.join(home, 'custom-codex-home');
  const result = installSkills({ home, codexHome: custom });
  assert.equal(result.destinations.length, 3);
  for (const root of result.destinations) {
    assert.match(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8'), /name: triangle-bridge/);
    for (const module of ['antigravity_bridge.mjs', 'desktop_rpc.mjs', 'claude_visible_transport.mjs', 'codex_desktop_settings.mjs', 'desktop_lifecycle.mjs'])
      assert.equal(fs.existsSync(path.join(root, 'scripts', module)), true);
  }
  const untouched = path.join(result.destinations[0], 'custom.txt');
  fs.writeFileSync(untouched, 'preserved');
  installSkills({ home, codexHome: custom });
  assert.equal(fs.readFileSync(untouched, 'utf8'), 'preserved');
});
