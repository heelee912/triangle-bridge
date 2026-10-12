// Connect only to an app's existing local debugger; never start a browser.
export async function evaluateDesktop(wsUrl, expression, { timeoutMs = 15000, mutation = false } = {}) {
  const url = new URL(wsUrl);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Desktop endpoint must be local');
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('Desktop connection timed out')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Desktop connection failed')); }, { once: true });
    });
    return await new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => { if (settled) return; settled = true; if (mutation) error.delivery = 'unknown'; reject(error); };
      const timer = setTimeout(() => fail(new Error('Desktop action timed out; read the exact session before retrying')), timeoutMs);
      ws.addEventListener('close', () => { clearTimeout(timer); fail(new Error('Desktop disconnected')); }, { once: true });
      ws.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { clearTimeout(timer); fail(new Error('Invalid desktop response')); return; }
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) {
          const error = new Error(message.error?.message || message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text);
          fail(error);
        } else { settled = true; resolve(message.result.result.value); }
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    if (ws.readyState === WebSocket.OPEN) await new Promise(resolve => {
      const timer = setTimeout(resolve, 250);
      ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.close();
    });
    else if (ws.readyState !== WebSocket.CLOSED) ws.close();
  }
}
