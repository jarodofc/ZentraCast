import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U8, serializeM3U } from '../src/iptv/m3u.ts';
import { buildWebVideoCasterUrl } from '../src/cast/web-video-caster.ts';
import { fetchPlaylistText, fetchPlaylistWithFailover, MAX_PLAYLIST_BYTES } from '../src/network/playlist.ts';

const playlist = '#EXTM3U\n' +
  '#EXTINF:-1 tvg-name="Jornal" tvg-logo="https://img.example/jornal.png" group-title="Notícias",Jornal\n' +
  '#EXTVLCOPT:http-referrer=https://site.example/ao-vivo\n' +
  '#EXTVLCOPT:http-user-agent=AppPlayer/1.0\n' +
  'https://video.example/jornal.m3u8\n' +
  '#EXTINF:-1 group-title="Notícias",Duplicado\nhttps://video.example/jornal.m3u8\n' +
  '#EXTINF:-1 group-title="Música",Música\nhttps://video.example/musica.mp4\n';

test('parser M3U extrai metadados, cabeçalhos e remove duplicatas', () => {
  const channels = parseM3U8(playlist);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].name, 'Jornal');
  assert.equal(channels[0].group, 'Notícias');
  assert.equal(channels[0].headers.Referer, 'https://site.example/ao-vivo');
  assert.equal(channels[0].headers['User-Agent'], 'AppPlayer/1.0');
  assert.equal(channels[1].name, 'Música');
});

test('exportação M3U preserva URL, título e cabeçalhos de compatibilidade', () => {
  const exported = serializeM3U(parseM3U8(playlist));
  assert.ok(exported.startsWith('#EXTM3U\n'));
  assert.ok(exported.includes('#EXTVLCOPT:http-referrer=https://site.example/ao-vivo'));
  assert.ok(exported.includes('#EXTVLCOPT:http-user-agent=AppPlayer/1.0'));
  assert.equal((exported.match(/https:\/\/video\.example\/jornal\.m3u8/g) || []).length, 1);
});

test('Web Video Caster codifica título, URL e headers corretamente', () => {
  const channel = parseM3U8(playlist)[0];
  const url = buildWebVideoCasterUrl({ ...channel, name: 'TV São Paulo' });
  assert.ok(url.startsWith('wvc-x-callback://open?'));
  assert.ok(url.includes('S%C3%A3o%20Paulo'));
  const query = new URLSearchParams(url.split('?')[1]);
  assert.equal(query.get('url'), channel.url);
  assert.equal(query.get('mime_type'), 'application/vnd.apple.mpegurl');
  assert.equal(query.getAll('header').length, 2);
  assert.equal(buildWebVideoCasterUrl({ name: 'Indevido', url: 'javascript:alert(1)' }), '');
});

test('download aceita playlist válida e recusa payload maior que o limite', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(playlist, { status: 200 });
    assert.equal(await fetchPlaylistText('https://playlist.example/list.m3u'), playlist);
    globalThis.fetch = async () => new Response(playlist, {
      status: 200, headers: { 'content-length': String(MAX_PLAYLIST_BYTES + 1) },
    });
    await assert.rejects(fetchPlaylistText('https://playlist.example/list.m3u'), /12 MB/);
  } finally { globalThis.fetch = previous; }
});

test('failover aceita fonte alternativa quando um espelho falha', async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { isSecureContext: false };
  try {
    globalThis.fetch = async url => {
      if (String(url).includes('falha')) throw new Error('Sem CORS');
      return new Response(playlist, { status: 200 });
    };
    const result = await fetchPlaylistWithFailover([
      { url: 'https://falha.example/lista.m3u', mirror: { label: 'Falha' } },
      { url: 'https://backup.example/lista.m3u', mirror: { label: 'Backup' } },
    ], 2000);
    assert.equal(result.mirror.label, 'Backup');
    assert.ok(result.text.includes('Jornal'));
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
  }
});
