import type { PlaylistResult } from '../types';

export const MAX_PLAYLIST_BYTES = 12 * 1024 * 1024;
export const PLAYLIST_CACHE_NAME = 'zplayer-playlists-v2';

export interface PlaylistMirror {
  url: string;
  mirror: { label: string };
}

/** Fetch limitado em bytes, com timeout, cancelamento e verificação M3U. */
export async function fetchPlaylistText(url: string, signal?: AbortSignal, timeoutMs = 12000): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL de playlist inválida.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, mode: 'cors', cache: 'no-cache' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const size = Number(response.headers.get('content-length') || 0);
    if (size > MAX_PLAYLIST_BYTES) throw new Error('Playlist excede 12 MB');
    let text = '';
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > MAX_PLAYLIST_BYTES) {
            await reader.cancel();
            throw new Error('Playlist excede 12 MB');
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    } else {
      text = await response.text();
    }
    text = text.replace(/^\uFEFF/, '');
    if (text.length > MAX_PLAYLIST_BYTES || !(/^\s*#EXTM3U\b/.test(text) || /^#EXTINF:/m.test(text))) {
      throw new Error('Conteúdo não é uma playlist M3U válida');
    }
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function saveCache(url: string, text: string): Promise<void> {
  if (!('caches' in window) || !window.isSecureContext) return;
  try {
    const cache = await caches.open(PLAYLIST_CACHE_NAME);
    await cache.put(url, new Response(text, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
  } catch { /* navegador pode restringir armazenamento */ }
}

async function readCached(mirrors: readonly PlaylistMirror[]): Promise<PlaylistResult | null> {
  if (!('caches' in window) || !window.isSecureContext) return null;
  try {
    const cache = await caches.open(PLAYLIST_CACHE_NAME);
    for (const { url } of mirrors) {
      const response = await cache.match(url);
      if (!response) continue;
      const text = await response.text();
      if (text.length <= MAX_PLAYLIST_BYTES && /#EXTINF:/.test(text)) {
        return { text, url, mirror: { label: 'Cache local' } };
      }
    }
  } catch { /* sem cache disponível */ }
  return null;
}

/** Espelhos paralelos, primeiro válido vence. Usa cache offline caso todos falhem. */
export async function fetchPlaylistWithFailover(
  mirrors: readonly PlaylistMirror[],
  timeoutMs = 12000,
): Promise<PlaylistResult> {
  const valid = mirrors.filter(item => /^https?:\/\//i.test(item.url));
  if (!valid.length) throw new Error('Nenhuma URL de playlist válida.');
  const controllers = valid.map(() => new AbortController());
  try {
    const result = await Promise.any(valid.map(async (candidate, i): Promise<PlaylistResult> => {
      const text = await fetchPlaylistText(candidate.url, controllers[i].signal, timeoutMs);
      return { text, url: candidate.url, mirror: candidate.mirror };
    }));
    void saveCache(result.url, result.text);
    return result;
  } catch {
    const cached = await readCached(valid);
    if (cached) return cached;
    throw new Error('Fontes indisponíveis ou bloqueadas por CORS. Importe um arquivo M3U local.');
  } finally {
    controllers.forEach(controller => controller.abort());
  }
}
