export function permissionSettings(mode) {
  if (mode === 'always-proceed') return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, permissions: null };
  if (mode === 'request-review') return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, permissions: null };
  throw new Error('Mode must be always-proceed or request-review');
}

export async function readDesktopSettings(bus, conversationId, hostId = 'local') {
  let snapshot;
  const stop = bus.onEvent(event => {
    if (event.method === 'thread-stream-state-changed' && event.params?.conversationId === conversationId &&
        event.params.hostId === hostId && event.params.change?.type === 'snapshot') snapshot = event.params.change.conversationState;
  });
  const following = value => bus.broadcast('thread-stream-following-changed', { conversationId, hostId, following: value });
  following(true);
  try {
    const response = await bus.request('thread-follower-load-complete-history', { conversationId }, { timeoutMs: 10000 });
    if (response.resultType !== 'success') throw new Error(response.error || 'Desktop settings read failed');
    if (!snapshot?.latestThreadSettings) throw new Error('Desktop settings snapshot unavailable');
    return { settings: snapshot.latestThreadSettings,
      activeTurnId: snapshot.turns?.findLast(t => t.status === 'inProgress')?.turnId };
  } finally { following(false); stop(); }
}

export async function setDesktopPermissions(bus, conversationId, mode, hostId) {
  if (hostId && hostId !== 'local') throw new Error('Desktop permission settings require the local host');
  const before = await readDesktopSettings(bus, conversationId, hostId);
  const expected = permissionSettings(mode);
  let response;
  try { response = await bus.request('thread-follower-update-thread-settings', { conversationId, threadSettings: expected,
    ...(before.activeTurnId ? { activeTurnId: before.activeTurnId } : {}) }, { timeoutMs: 15000 }); }
  catch (error) { error.delivery = 'unknown'; throw error; }
  if (response.resultType !== 'success' || response.result?.applied !== true) throw new Error(response.error || 'Desktop permission update was not applied');
  const after = await readDesktopSettings(bus, conversationId, hostId);
  if (after.settings.approvalPolicy !== expected.approvalPolicy || after.settings.sandboxPolicy?.type !== expected.sandboxPolicy.type) throw new Error('Desktop permission readback did not match');
  return { ok: true, conversationId, mode, approvalPolicy: after.settings.approvalPolicy, sandboxPolicy: after.settings.sandboxPolicy,
    model: after.settings.model, effort: after.settings.effort };
}
