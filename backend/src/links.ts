import { isIP } from 'node:net';
// These URLs are displayed, never fetched by our server. Reject local/IP/credential links anyway.
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!host.includes('.') || isIP(host) || host.startsWith('[') || /(^|\.)(localhost|local|localdomain|lan|home|internal|test|invalid|example)$/.test(host) || host === 'example.com' || host.endsWith('.example.com')) return null;
    url.hostname = host;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}
