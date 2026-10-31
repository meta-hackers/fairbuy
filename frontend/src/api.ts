import type { ShoppingSession } from '@fairbuy/core';
export interface Bootstrap {
  mode: 'demo' | 'live'; accessRequired: boolean; aiConfigured: boolean;
  searchProvider: string; persistent: boolean; session: ShoppingSession | null;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Fairbuy-Request': '1' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error('Cannot reach FairBuy. Check your connection and try again.'); }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? `Request failed (${response.status}). Please try again.`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
