type HlsConstructor = typeof import('hls.js').default;

let inflight: Promise<HlsConstructor> | null = null;
const CDNS = [
  'https://cdn.jsdelivr.net/npm/hls.js@1.7.4/dist/hls.min.js',
  'https://unpkg.com/hls.js@1.7.4/dist/hls.min.js',
] as const;

type WindowWithHls = Window & { Hls?: HlsConstructor };

async function loadFallback(): Promise<HlsConstructor> {
  const browser = window as WindowWithHls;
  if (browser.Hls) return browser.Hls;
  for (const url of CDNS) {
    try {
      await new Promise<void>((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = url;
        tag.async = true;
        tag.crossOrigin = 'anonymous';
        const timeout = setTimeout(() => {
          tag.remove();
          reject(new Error('Timeout de HLS'));
        }, 8500);
        tag.onload = () => { clearTimeout(timeout); resolve(); };
        tag.onerror = () => { clearTimeout(timeout); tag.remove(); reject(new Error('CDN não respondeu')); };
        document.head.appendChild(tag);
      });
      if (browser.Hls) return browser.Hls;
    } catch { /* tenta o próximo CDN */ }
  }
  throw new Error('Não foi possível carregar o motor HLS. Verifique a conexão.');
}

/** Import dinâmico gera chunk local; os CDNs só são usados como recuperação. */
export function loadHlsLibrary(): Promise<HlsConstructor> {
  if (inflight) return inflight;
  inflight = import('hls.js')
    .then(module => module.default)
    .catch(() => loadFallback())
    .catch(error => { inflight = null; throw error; });
  return inflight;
}
