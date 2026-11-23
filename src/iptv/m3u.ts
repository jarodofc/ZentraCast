import type { Channel, StreamHeaders } from '../types';

function safeHttpUrl(value: string | undefined): string {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
}
function getHost(value: string): string {
  try { return new URL(value).hostname; } catch { return ''; }
}
function isDirectIp(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':');
}

interface Metadata {
  name: string;
  tvgName: string;
  logo: string;
  group: string;
  subtitle: string;
  headers: StreamHeaders;
}

/** Parser síncrono. Ignora linhas que não sejam URLs HTTP(S) e remove duplicatas. */
export function parseM3U8(rawText: string, onDirectIp?: (host: string) => void): Channel[] {
  const lines = rawText.split(/\r?\n/);
  const channels: Channel[] = [];
  const seenUrls = new Set<string>();
  const attrRegex = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;
  let pending: Metadata | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const attrs: Record<string, string> = {};
      attrRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = attrRegex.exec(line)) !== null) attrs[match[1].toLowerCase()] = match[2].trim();
      const lastQuote = line.lastIndexOf('"');
      const comma = line.indexOf(',', lastQuote === -1 ? 0 : lastQuote);
      const displayName = comma !== -1 ? line.slice(comma + 1).trim() : '';
      pending = {
        name: displayName || attrs['tvg-name'] || 'Canal sem nome',
        tvgName: attrs['tvg-name'] || '',
        logo: safeHttpUrl(attrs['tvg-logo']),
        group: attrs['group-title'] || 'Geral',
        subtitle: safeHttpUrl(attrs['tvg-subtitle']),
        headers: {},
      };
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:') && pending) {
      const option = line.slice(11);
      const separator = option.indexOf('=');
      if (separator > 0) {
        const key = option.slice(0, separator).toLowerCase().trim();
        const value = option.slice(separator + 1).trim().replace(/[\r\n]/g, '');
        if (key === 'http-referrer' && value.length <= 512 && safeHttpUrl(value)) pending.headers.Referer = value;
        if (key === 'http-user-agent' && value.length <= 200) pending.headers['User-Agent'] = value;
      }
      continue;
    }
    if (line.startsWith('#EXTGRP:') && pending) {
      const group = line.slice(8).trim();
      if (group && pending.group === 'Geral') pending.group = group;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!safeHttpUrl(line)) { pending = null; continue; }
    if (seenUrls.has(line)) { pending = null; continue; }
    seenUrls.add(line);
    const metadata: Metadata = pending || {
      name: 'Stream #' + (channels.length + 1), tvgName: '', logo: '',
      group: 'Geral', subtitle: '', headers: {},
    };
    const host = getHost(line);
    if (host && isDirectIp(host)) onDirectIp?.(host);
    channels.push({
      id: channels.length + '_' + line, name: metadata.name, tvgName: metadata.tvgName,
      logo: metadata.logo, group: metadata.group || 'Geral', url: line, host,
      subtitle: metadata.subtitle, headers: metadata.headers,
      searchKey: [metadata.name, metadata.tvgName, metadata.group, host].join(' ').toLowerCase(),
    });
    pending = null;
  }
  return channels;
}

/** Exportação de playlists para importação em aplicativos de cast e TV. */
export function serializeM3U(channels: readonly Channel[]): string {
  const clean = (value: unknown): string => String(value ?? '').replace(/[\r\n"]/g, ' ').slice(0, 240);
  const lines: string[] = ['#EXTM3U'];
  for (const channel of channels) {
    if (!safeHttpUrl(channel.url)) continue;
    lines.push(
      '#EXTINF:-1 tvg-name="' + clean(channel.tvgName || channel.name) +
      '" tvg-logo="' + clean(channel.logo) + '" group-title="' + clean(channel.group) +
      '",' + clean(channel.name),
    );
    if (channel.headers?.Referer) lines.push('#EXTVLCOPT:http-referrer=' + channel.headers.Referer);
    if (channel.headers?.['User-Agent']) lines.push('#EXTVLCOPT:http-user-agent=' + channel.headers['User-Agent']);
    lines.push(channel.url);
  }
  return lines.join('\n') + '\n';
}
