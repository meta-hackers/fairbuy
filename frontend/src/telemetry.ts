type ErrorType = 'Error' | 'TypeError' | 'ReferenceError' | 'SyntaxError' | 'RangeError' | 'UnknownError';
type ClientEvent =
  | { kind: 'image_unavailable'; sessionId: string; productId: string }
  | { kind: 'runtime_error' | 'unhandled_rejection'; errorType: ErrorType; asset?: string; line?: number; column?: number };

// Best effort only: reporting must never break the app or create an error loop.
// Deduplicate repeated render/load errors and bound reports for each page visit.
const reported = new Set<string>();
export function reportClientEvent(event: ClientEvent) {
  const key = JSON.stringify(event);
  if (reported.has(key) || reported.size >= 20) return;
  reported.add(key);
  void fetch('/api/client-events', {
    method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Fairbuy-Request': '1' }, body: key,
  }).catch(() => undefined);
}

function errorType(error: unknown): ErrorType {
  const name = error instanceof Error ? error.name : '';
  return ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(name) ? name as ErrorType : 'UnknownError';
}

export function installErrorReporting() {
  window.addEventListener('error', event => {
    let asset: string | undefined;
    try {
      const url = new URL(event.filename);
      if (url.origin === location.origin && /^\/assets\/[\w.-]+\.js$/.test(url.pathname)) asset = url.pathname;
    } catch { /* Do not collect arbitrary resource URLs. */ }
    reportClientEvent({ kind: 'runtime_error', errorType: errorType(event.error), ...(asset ? { asset, line: event.lineno, column: event.colno } : {}) });
  });
  window.addEventListener('unhandledrejection', event => {
    reportClientEvent({ kind: 'unhandled_rejection', errorType: errorType(event.reason) });
  });
}
