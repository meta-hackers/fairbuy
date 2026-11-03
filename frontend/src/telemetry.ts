import type { ClientEvent } from '@fairbuy/core';
type ErrorType = 'Error' | 'TypeError' | 'ReferenceError' | 'SyntaxError' | 'RangeError' | 'UnknownError';

const imageTraces = new Map<string, string>();
let activeSessionId: string | null = null;
export function setDiagnosticSession(sessionId: string | null) { activeSessionId = sessionId; }
function newTraceId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID requires a secure context; getRandomValues also works on HTTP
  // LAN development origins. Diagnostics must not break image rendering there.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function imageTraceId(key: string) {
  let traceId = imageTraces.get(key);
  if (!traceId) {
    traceId = newTraceId();
    imageTraces.set(key, traceId);
    if (imageTraces.size > 500) imageTraces.delete(imageTraces.keys().next().value!);
  }
  return traceId;
}

// Best effort only: reporting must never break the app or create an error loop.
// Deduplicate repeated render/load errors and bound reports for each page visit.
const reported = new Set<string>();
export function reportClientEvent(event: ClientEvent) {
  const enriched = event.kind !== 'image_unavailable' && activeSessionId ? { ...event, sessionId: activeSessionId } : event;
  const key = JSON.stringify(enriched);
  if (reported.has(key) || reported.size >= 20) return;
  reported.add(key);
  void fetch('/api/client-events', {
    method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Fairbuy-Request': '1' },
    body: JSON.stringify({ ...enriched, traceId: event.traceId ?? newTraceId() }),
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
