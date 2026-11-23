import type { Channel } from '../types';

function validHttpUrl(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  try {
    const url = new URL(input);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch { return false; }
}

/** URL registrada pelo Web Video Caster para receber o stream na aplicação móvel. */
export function buildWebVideoCasterUrl(
  channel: Pick<Channel, 'url' | 'name'> & Partial<Pick<Channel, 'logo' | 'subtitle' | 'headers'>>,
): string {
  if (!validHttpUrl(channel.url)) return '';
  const params = new URLSearchParams();
  params.set('url', channel.url);
  params.set('title', String(channel.name || 'IPTV').slice(0, 160));
  if (validHttpUrl(channel.logo)) params.set('poster', channel.logo);
  if (validHttpUrl(channel.subtitle)) params.set('subtitle', channel.subtitle);
  if (/\.m3u8?(?:[?#]|$)/i.test(channel.url)) {
    params.set('mime_type', 'application/vnd.apple.mpegurl');
  }
  if (validHttpUrl(channel.headers?.Referer)) {
    params.append('header', 'Referer: ' + channel.headers.Referer.slice(0, 512));
  }
  if (channel.headers?.['User-Agent']) {
    params.append('header', 'User-Agent: ' + channel.headers['User-Agent'].slice(0, 200));
  }
  // x-callback exige percent encoding (%20, não '+' no valor).
  return 'wvc-x-callback://open?' + Array.from(params.entries())
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
}
