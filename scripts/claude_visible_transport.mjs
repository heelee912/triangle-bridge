import { randomUUID } from 'node:crypto';

export function buildVisibleUserFrame(sessionId, prompt, messageId = randomUUID()) {
  if (!sessionId || typeof prompt !== 'string' || !prompt.trim()) throw new Error('Visible input requires an exact session and nonempty prompt');
  return JSON.stringify({ type: 'user', session_id: sessionId, uuid: messageId,
    message: { role: 'user', content: prompt } });
}

export function chooseDesktopSendTransport(surface, { renderer, raw, visible = true } = {}) {
  if (renderer) return 'renderer';
  if (raw) return 'raw';
  if (surface === 'code' && visible) return 'live-stdin';
  return null;
}
