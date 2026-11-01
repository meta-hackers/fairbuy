import { isIP } from 'node:net';
// Basic URL validation. Server fetches must additionally validate and pin DNS addresses.
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
// A deliberately small public-suffix approximation for image-domain checks.
const secondLevel = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'com.br', 'com.mx', 'co.in', 'com.sg', 'co.za', 'com.tr']);
export function siteKey(hostname: string) {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tail = labels.slice(-2).join('.');
  return secondLevel.has(tail) ? labels.slice(-3).join('.') : tail;
}
/** Accept only public HTTPS images hosted on the same site as a returned research source. */
export function safeImageUrl(value: string | null | undefined, sourceUrls: string[]): string | null {
  const image = value ? safeUrl(value) : null;
  if (!image) return null;
  const host = new URL(image).hostname;
  return sourceUrls.some(source => {
    const sourceUrl = safeUrl(source);
    return !!sourceUrl && siteKey(new URL(sourceUrl).hostname) === siteKey(host);
  }) ? image : null;
}
