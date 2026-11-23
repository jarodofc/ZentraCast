// @ts-nocheck
// O controlador da UI ainda contém DOM dinâmico legado; os novos serviços
// são TypeScript estrito e testáveis. A migração de DOM será incremental.
import { OFFICIAL_PLAYLISTS, CDN_MIRRORS } from './iptv/catalogs';
import { parseM3U8 as parseM3U8Typed, serializeM3U } from './iptv/m3u';
import { fetchPlaylistWithFailover, MAX_PLAYLIST_BYTES, PLAYLIST_CACHE_NAME } from './network/playlist';
import { buildWebVideoCasterUrl } from './cast/web-video-caster';
import { loadHlsLibrary } from './player/hls-loader';

(() => {
      'use strict';

      /* ======================================================================
         CONFIGURAÇÃO
         ====================================================================== */
      const STORAGE_KEYS = {
        FAVORITES: 'iptvbr2026_favorites',
        THEME: 'iptvbr2026_theme',
        SOLID: 'iptvbr2026_solid',
        CUSTOM_DOH: 'iptvbr2026_custom_doh',
      };

      const HANDSHAKE_TEST_HOST = 'raw.githubusercontent.com';
      const DOH_TIMEOUT_MS = 3200;
      const MIN_TTL_SEC = 60;
      const MAX_TTL_SEC = 600;
      const PAGE_SIZE = 60;
      const BATCH_CONCURRENCY = 6;

      // Fontes verificadas, acessadas diretamente no navegador.
      // Catálogos e espelhos definidos em src/iptv/catalogs.ts

      const DEFAULT_DOH_PROVIDERS = [
        { id: 'cloudflare', name: 'Cloudflare DNS', subtitle: '1.1.1.1 • Anycast Global',
          template: 'https://cloudflare-dns.com/dns-query?name={host}&type={type}', acceptDnsJson: true, custom: false },
        { id: 'google', name: 'Google Public DNS', subtitle: '8.8.8.8 • DNS JSON API',
          template: 'https://dns.google/resolve?name={host}&type={type}', acceptDnsJson: false, custom: false },
        { id: 'cloudflare-sec', name: 'Cloudflare Security', subtitle: '1.1.1.2 • Proteção Malware',
          template: 'https://security.cloudflare-dns.com/dns-query?name={host}&type={type}', acceptDnsJson: true, custom: false },
        { id: 'dnssb', name: 'DNS.SB Anycast', subtitle: '185.222.222.222 • Privacidade',
          template: 'https://doh.dns.sb/dns-query?name={host}&type={type}', acceptDnsJson: true, custom: false },
        { id: 'alidns', name: 'Alibaba Public DNS', subtitle: '223.5.5.5 • Alta Redundância',
          template: 'https://dns.alidns.com/resolve?name={host}&type={type}', acceptDnsJson: false, custom: false },
      ];

      const DNS_STATUS_MAP = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };
      const DNS_TYPE_NUM = { A: 1, CNAME: 5, TXT: 16, AAAA: 28 };

      /* ======================================================================
         UTILITÁRIOS DE STORAGE (declarados antes do estado)
         ====================================================================== */
      function loadJsonStorage(key, fallback) {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : fallback;
        } catch { return fallback; }
      }
      function saveJsonStorage(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
      }
      function loadStringStorage(key, fallback) {
        try {
          const val = localStorage.getItem(key);
          return val !== null ? val : fallback;
        } catch { return fallback; }
      }

      /* ======================================================================
         ESTADO GLOBAL
         ====================================================================== */
      const state = {
        dohProviders: [],
        activeDohId: null,
        bootCompleted: false,

        dnsCache: new Map(),
        cacheHits: 0,
        cacheMisses: 0,

        hostHealthMap: new Map(),
        batchAuditing: false,
        batchAbortFlag: false,

        currentPlaylist: OFFICIAL_PLAYLISTS[0],
        allChannels: [],
        filteredChannels: [],
        renderedCount: 0,
        activeCategory: 'Todas',
        activeTab: 'all',
        onlyActiveDns: false,
        searchQuery: '',
        playlistLoadSeq: 0,
        extraCatalogs: [],

        favorites: loadJsonStorage(STORAGE_KEYS.FAVORITES, {}),
        currentChannel: null,
        currentChannelDns: null,
        hlsInstance: null,
        hlsRetryCount: 0,
        streamPlaybackSeq: 0,

        theme: loadStringStorage(STORAGE_KEYS.THEME, 'dark') === 'light' ? 'light' : 'dark',
        solidMode: loadStringStorage(STORAGE_KEYS.SOLID, 'false') === 'true',
      };

      /* ======================================================================
         REFERÊNCIAS DOM
         ====================================================================== */
      const $ = (id) => document.getElementById(id);
      const dom = {
        bootGate: $('boot-gate'), bootSubtitle: $('boot-subtitle'), bootStatusText: $('boot-status-text'),
        bootProgressBar: $('boot-progress-bar'), bootProgressPct: $('boot-progress-pct'),
        bootDohList: $('boot-doh-list'), bootEnterNowBtn: $('boot-enter-now-btn'), appShell: $('app-shell'),

        headerDnsDot: $('header-dns-dot'), headerDnsName: $('header-dns-name'), headerDnsLatency: $('header-dns-latency'),
        openDnsModalBtn: $('open-dns-modal-btn'), toggleSolidBtn: $('toggle-solid-btn'), solidBtnLabel: $('solid-btn-label'),
        toggleThemeBtn: $('toggle-theme-btn'), iconSun: $('icon-sun'), iconMoon: $('icon-moon'),
        openImportModalBtn: $('open-import-modal-btn'), playlistPills: $('playlist-pills'),

        playerWrapper: $('player-wrapper'), video: $('video-player'), playerLogoBox: $('player-channel-logo-box'),
        playerTitle: $('player-channel-title'), playerGroup: $('player-channel-group'),
        streamStatusBadge: $('stream-status-badge'), streamDnsPill: $('stream-dns-pill'),
        playerIdleOverlay: $('player-idle-overlay'), playerLoadingOverlay: $('player-loading-overlay'),
        playerLoadingText: $('player-loading-text'), playerErrorOverlay: $('player-error-overlay'),
        errorCategoryTag: $('error-category-tag'), errorTitle: $('error-title'), errorDetail: $('error-detail'),
        errorTryHttpsBtn: $('error-try-https-btn'), errorCopyBtn: $('error-copy-btn'),
        errorReloadBtn: $('error-reload-btn'), errorExternalLink: $('error-external-link'),

        ctrlPlayBtn: $('ctrl-play-btn'), iconPlay: $('icon-play'), iconPause: $('icon-pause'),
        ctrlReloadBtn: $('ctrl-reload-btn'), ctrlMuteBtn: $('ctrl-mute-btn'),
        iconVolOn: $('icon-vol-on'), iconVolOff: $('icon-vol-off'), ctrlVolumeSlider: $('ctrl-volume-slider'),
        ctrlFavBtn: $('ctrl-fav-btn'), ctrlFavIcon: $('ctrl-fav-icon'), ctrlCopyBtn: $('ctrl-copy-btn'),
        ctrlExternalBtn: $('ctrl-external-btn'), ctrlPipBtn: $('ctrl-pip-btn'), ctrlFullscreenBtn: $('ctrl-fullscreen-btn'),

        cdnOriginStatus: $('cdn-origin-status'), cacheMiniIndicator: $('cache-mini-indicator'),

        telemetryResolverLine: $('telemetry-resolver-line'), telemetryStatusChip: $('telemetry-status-chip'),
        telemetryDnssecChip: $('telemetry-dnssec-chip'), telemetryDetailsBtn: $('telemetry-details-btn'),
        telHostname: $('tel-hostname'), telIp: $('tel-ip'), telTtl: $('tel-ttl'), telLatency: $('tel-latency'),

        currentPlaylistName: $('current-playlist-name'), channelCounter: $('channel-counter'),
        tabAllBtn: $('tab-all-btn'), tabFavBtn: $('tab-fav-btn'), favCountBadge: $('fav-count-badge'),
        searchInput: $('search-input'), clearSearchBtn: $('clear-search-btn'),
        batchAuditBtn: $('batch-audit-btn'), batchAuditIcon: $('batch-audit-icon'), batchAuditLabel: $('batch-audit-label'),
        onlyActiveDnsSwitch: $('only-active-dns-switch'), batchAuditProgressBox: $('batch-audit-progress-box'),
        batchAuditText: $('batch-audit-text'), batchAuditStats: $('batch-audit-stats'), batchAuditBar: $('batch-audit-bar'),
        categoryChips: $('category-chips'), channelListContainer: $('channel-list-container'),
        listLoadingState: $('list-loading-state'), channelList: $('channel-list'),
        loadMoreContainer: $('load-more-container'), loadMoreBtn: $('load-more-btn'),
        listEmptyState: $('list-empty-state'), emptyStateTitle: $('empty-state-title'),
        emptyStateDesc: $('empty-state-desc'), retryPlaylistBtn: $('retry-playlist-btn'),

        dnsModal: $('dns-modal'), closeDnsModalBtn: $('close-dns-modal-btn'), modalRetestDohBtn: $('modal-retest-doh-btn'),
        modalDohList: $('modal-doh-list'), modalCacheStats: $('modal-cache-stats'), clearDnsCacheBtn: $('clear-dns-cache-btn'),
        manualLookupForm: $('manual-lookup-form'), lookupDomainInput: $('lookup-domain-input'),
        lookupTypeSelect: $('lookup-type-select'), lookupSubmitBtn: $('lookup-submit-btn'),
        lookupResultBox: $('lookup-result-box'), lookupRecordsSummary: $('lookup-records-summary'),
        lookupJsonOutput: $('lookup-json-output'), customDohName: $('custom-doh-name'),
        customDohUrl: $('custom-doh-url'), customDohAccept: $('custom-doh-accept'), addCustomDohBtn: $('add-custom-doh-btn'),

        importModal: $('import-modal'), closeImportModalBtn: $('close-import-modal-btn'),
        importUrlInput: $('import-url-input'), importUrlSubmitBtn: $('import-url-submit-btn'),
        importFileInput: $('import-file-input'),

        toastContainer: $('toast-container'), ghDynamicIsland: $('gh-dynamic-island'),
      };

      /* ======================================================================
         UTILITÁRIOS
         ====================================================================== */
      function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      function isIpAddress(host) {
        if (!host) return false;
        const clean = host.replace(/^\[|\]$/g, '');
        if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(clean)) {
          return clean.split('.').every(n => Number(n) >= 0 && Number(n) <= 255);
        }
        return clean.includes(':');
      }

      function extractHostname(urlStr) {
        try {
          return new URL(urlStr).hostname.replace(/^\[|\]$/g, '').toLowerCase();
        } catch { return ''; }
      }

      // Só permite http(s) em logos para evitar esquemas perigosos (javascript:, data:)
      function safeImageUrl(url) {
        return /^https?:\/\//i.test(url || '') ? url : '';
      }

      function copyToClipboard(text, successMsg = 'Copiado para a área de transferência') {
        if (!text) return;
        const fallback = () => {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, text.length);
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            showToast(ok ? successMsg : 'Não foi possível copiar o link.', ok ? 'success' : 'error');
          } catch {
            showToast('Erro ao copiar para a área de transferência.', 'error');
          }
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(() => showToast(successMsg, 'success')).catch(fallback);
        } else {
          fallback();
        }
      }

      function showToast(message, type = 'info') {
        const borderColors = { success: 'border-emerald-400/40', error: 'border-rose-400/40', warning: 'border-amber-400/40', info: 'border-cyan-400/40' };
        const icons = {
          success: '<svg class="w-4 h-4 text-emerald-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="20 6 9 17 4 12"/></svg>',
          error: '<svg class="w-4 h-4 text-rose-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
          warning: '<svg class="w-4 h-4 text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
          info: '<svg class="w-4 h-4 text-cyan-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        };
        const toast = document.createElement('div');
        toast.className = `pointer-events-auto liquid-glass-elevated rounded-2xl px-3.5 py-2.5 flex items-center gap-2.5 text-xs font-semibold animate-fade-up ${borderColors[type] || borderColors.info}`;
        toast.innerHTML = `${icons[type] || icons.info}<span>${escapeHtml(message)}</span>`;
        dom.toastContainer.appendChild(toast);
        setTimeout(() => {
          toast.style.transition = 'opacity 0.28s ease, transform 0.28s ease';
          toast.style.opacity = '0';
          toast.style.transform = 'translateY(8px)';
          setTimeout(() => toast.remove(), 300);
        }, 3600);
      }

      /* ======================================================================
         APARÊNCIA
         ====================================================================== */
      function applyThemeAndSurface() {
        const html = document.documentElement;
        const isLight = state.theme === 'light';
        html.classList.toggle('light', isLight);
        html.classList.toggle('dark', !isLight);
        dom.iconSun.classList.toggle('hidden', !isLight);
        dom.iconMoon.classList.toggle('hidden', isLight);
        html.classList.toggle('solid-mode', state.solidMode);
        dom.solidBtnLabel.textContent = state.solidMode ? 'Sólido' : 'Vidro';
        dom.toggleSolidBtn.classList.toggle('active', state.solidMode);
        try {
          localStorage.setItem(STORAGE_KEYS.THEME, state.theme);
          localStorage.setItem(STORAGE_KEYS.SOLID, String(state.solidMode));
        } catch {}
      }

      /* ======================================================================
         MOTOR DoH
         ====================================================================== */
      function initDohPool() {
        const savedCustom = loadJsonStorage(STORAGE_KEYS.CUSTOM_DOH, []);
        const customList = Array.isArray(savedCustom) ? savedCustom : [];
        state.dohProviders = [...DEFAULT_DOH_PROVIDERS, ...customList.filter(p => p && /^https:\/\//i.test(p.template || ""))].map(p => ({
          ...p, status: 'idle', latency: null, resolvedIp: null, dnssec: false,
        }));
      }

      function saveCustomDohProviders() {
        const customOnly = state.dohProviders.filter(p => p.custom)
          .map(({ id, name, subtitle, template, acceptDnsJson, custom }) => ({ id, name, subtitle, template, acceptDnsJson, custom }));
        saveJsonStorage(STORAGE_KEYS.CUSTOM_DOH, customOnly);
      }

      function buildDohUrl(provider, host, type) {
        const encHost = encodeURIComponent(host);
        const encType = encodeURIComponent(type);
        if (provider.template.includes('{host}') || provider.template.includes('{type}')) {
          return provider.template.replace(/\{host\}/g, encHost).replace(/\{type\}/g, encType);
        }
        const sep = provider.template.includes('?') ? '&' : '?';
        return `${provider.template}${sep}name=${encHost}&type=${encType}`;
      }

      function getActiveDohProvider() {
        return state.dohProviders.find(p => p.id === state.activeDohId)
          || state.dohProviders.find(p => p.status === 'online')
          || state.dohProviders[0];
      }

      function getHealthyDohSorted() {
        return state.dohProviders.filter(p => p.status === 'online')
          .sort((a, b) => (a.latency ?? 99999) - (b.latency ?? 99999));
      }

      async function queryProviderDoh(provider, host, type = 'A', timeoutMs = DOH_TIMEOUT_MS) {
        const url = buildDohUrl(provider, host, type);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const start = performance.now();

        try {
          const resp = await fetch(url, {
            method: 'GET',
            headers: { Accept: provider.acceptDnsJson ? 'application/dns-json' : 'application/json' },
            signal: controller.signal,
            cache: 'no-store',
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          if (typeof json.Status !== 'number') throw new Error('Payload DoH JSON inválido');

          const latency = Math.max(1, Math.round(performance.now() - start));
          const answers = Array.isArray(json.Answer) ? json.Answer : [];
          const statusCode = json.Status;
          const ttls = answers.map(a => Number(a.TTL)).filter(n => Number.isFinite(n) && n > 0);
          const rawTtl = ttls.length ? Math.min(...ttls) : 120;
          const clampedTtl = Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, rawTtl));

          return {
            ok: true, host, type, statusCode,
            statusText: DNS_STATUS_MAP[statusCode] || `RCODE_${statusCode}`,
            dnssec: Boolean(json.AD), answers, ttl: clampedTtl, rawTtl, latency,
            resolverId: provider.id, resolverName: provider.name, rawJson: json, fromCache: false,
          };
        } finally {
          clearTimeout(timer);
        }
      }

      async function resolveDns(host, type = 'A', options = {}) {
        const cleanHost = String(host || '').trim().toLowerCase().replace(/\.$/, '');
        if (!cleanHost || cleanHost.length > 253 || !/^[a-z0-9.:-]+$/i.test(cleanHost)) throw new Error("Domínio inválido para consulta DoH");
        const cleanType = String(type || 'A').toUpperCase();
        const cacheKey = `${cleanHost}|${cleanType}`;
        const now = Date.now();

        if (!options.bypassCache) {
          const cached = state.dnsCache.get(cacheKey);
          if (cached && cached.expiresAt > now) {
            state.cacheHits++;
            updateCacheStatsUi();
            return {
              ...cached.result, fromCache: true, latency: 0,
              remainingTtl: Math.max(1, Math.round((cached.expiresAt - now) / 1000)),
            };
          } else if (cached) {
            state.dnsCache.delete(cacheKey);
          }
        }

        state.cacheMisses++;

        // Fila de failover: ativo -> online por latência -> idle/testing -> offline (por último)
        const queue = [];
        const push = (p) => { if (p && !queue.some(q => q.id === p.id)) queue.push(p); };
        const active = getActiveDohProvider();
        if (active && active.status !== 'offline') push(active);
        getHealthyDohSorted().forEach(push);
        state.dohProviders.filter(p => p.status !== 'offline').forEach(push);
        state.dohProviders.forEach(push);

        let lastError = null;
        for (const provider of queue) {
          try {
            const result = await queryProviderDoh(provider, cleanHost, cleanType);
            state.dnsCache.set(cacheKey, { result, expiresAt: Date.now() + result.ttl * 1000 });
            updateCacheStatsUi();
            return { ...result, remainingTtl: result.ttl };
          } catch (err) {
            lastError = err;
          }
        }

        updateCacheStatsUi();
        throw lastError || new Error('Todos os provedores DoH falharam.');
      }

      async function preflightChannelDns(streamUrl) {
        const host = extractHostname(streamUrl);
        const baseFail = {
          host: host || 'Inválido', isDirectIp: false, ok: false, statusCode: null, statusText: 'DOH_ERRO',
          ipv4: [], ipv6: [], cname: [], ttl: null, dnssec: false, latency: 0,
          resolverName: getActiveDohProvider()?.name || 'DoH', fromCache: false,
        };

        if (!host) return { ...baseFail, statusText: 'URL_INVALIDA' };

        if (isIpAddress(host)) {
          const isV6 = host.includes(':');
          state.hostHealthMap.set(host, { ok: true, status: 'IP Direto', ip: host, isDirectIp: true });
          return {
            host, isDirectIp: true, ok: true, statusCode: 0, statusText: 'IP Direto',
            ipv4: isV6 ? [] : [host], ipv6: isV6 ? [host] : [], cname: [], ttl: null, dnssec: false,
            latency: 0, resolverName: 'Conexão IP Literal', fromCache: false,
          };
        }

        const [aRes, aaaaRes, cnameRes] = await Promise.allSettled([
          resolveDns(host, 'A'), resolveDns(host, 'AAAA'), resolveDns(host, 'CNAME'),
        ]);
        const aVal = aRes.status === 'fulfilled' ? aRes.value : null;
        const aaaaVal = aaaaRes.status === 'fulfilled' ? aaaaRes.value : null;
        const cnameVal = cnameRes.status === 'fulfilled' ? cnameRes.value : null;
        const primary = aVal || aaaaVal || cnameVal;

        if (!primary) return baseFail;

        const ipv4 = (aVal?.answers || []).filter(r => r.type === DNS_TYPE_NUM.A).map(r => r.data);
        const ipv6 = (aaaaVal?.answers || []).filter(r => r.type === DNS_TYPE_NUM.AAAA).map(r => r.data);
        const cname = Array.from(new Set([
          ...(aVal?.answers || []).filter(r => r.type === DNS_TYPE_NUM.CNAME).map(r => String(r.data).replace(/\.$/, '')),
          ...(cnameVal?.answers || []).filter(r => r.type === DNS_TYPE_NUM.CNAME).map(r => String(r.data).replace(/\.$/, '')),
        ]));

        const hasAddress = ipv4.length > 0 || ipv6.length > 0;
        const ok = primary.statusCode === 0 && (hasAddress || cname.length > 0);
        const latency = Math.max(aVal?.latency || 0, aaaaVal?.latency || 0, cnameVal?.latency || 0);
        const allCached = [aVal, aaaaVal, cnameVal].filter(Boolean).every(v => v.fromCache);

        state.hostHealthMap.set(host, { ok, status: primary.statusText, ip: ipv4[0] || ipv6[0] || cname[0] || '', isDirectIp: false });

        return {
          host, isDirectIp: false, ok, statusCode: primary.statusCode, statusText: primary.statusText,
          ipv4, ipv6, cname, ttl: primary.remainingTtl ?? primary.ttl,
          dnssec: Boolean(aVal?.dnssec || aaaaVal?.dnssec), latency,
          resolverName: primary.resolverName, fromCache: allCached,
        };
      }

      async function benchmarkDohProvider(provider) {
        provider.status = 'testing';
        provider.latency = null; provider.resolvedIp = null; provider.dnssec = false;
        renderDohViews();
        try {
          const res = await queryProviderDoh(provider, HANDSHAKE_TEST_HOST, 'A', DOH_TIMEOUT_MS);
          const firstIp = res.answers.find(a => a.type === DNS_TYPE_NUM.A)?.data || 'OK';
          provider.status = res.statusCode === 0 ? 'online' : 'offline';
          provider.latency = res.latency;
          provider.resolvedIp = firstIp;
          provider.dnssec = res.dnssec;
          renderDohViews();
          return { provider, ok: provider.status === 'online', latency: res.latency, ip: firstIp };
        } catch (err) {
          provider.status = 'offline';
          renderDohViews();
          return { provider, ok: false, error: err.message };
        }
      }

      async function runBootDnsHandshake() {
        let finished = 0;
        const total = state.dohProviders.length;
        renderBootDohList();

        await Promise.allSettled(state.dohProviders.map(async (provider) => {
          const res = await benchmarkDohProvider(provider);
          finished++;
          const pct = Math.min(100, Math.round((finished / total) * 100));
          dom.bootProgressBar.style.width = `${pct}%`;
          dom.bootProgressPct.textContent = `${pct}%`;

          if (res.ok) {
            const current = state.dohProviders.find(p => p.id === state.activeDohId);
            if (!current || current.status !== 'online' || res.latency < (current.latency ?? Infinity)) {
              state.activeDohId = provider.id;
            }
          }
          renderDohViews();
        }));

        if (state.bootCompleted) return;

        const healthy = getHealthyDohSorted();
        if (healthy.length > 0) {
          const fastest = healthy[0];
          state.activeDohId = fastest.id;
          renderDohViews();
          dom.bootStatusText.innerHTML = `
            <svg class="w-4 h-4 text-emerald-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            <span class="text-emerald-400 font-bold truncate">Vencedor: ${escapeHtml(fastest.name)} (${fastest.latency} ms • ${escapeHtml(fastest.resolvedIp)})</span>`;
          dom.bootSubtitle.textContent = 'Diagnóstico DoH concluído. Carregando listas diretamente...';
          setTimeout(enterMainApp, 750);
        } else {
          state.activeDohId = state.dohProviders[0].id;
          renderDohViews();
          dom.bootStatusText.innerHTML = `
            <svg class="w-4 h-4 text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
            <span class="text-amber-300 font-semibold truncate">Rede instável no handshake — entrando com fallback CDN direto</span>`;
          setTimeout(enterMainApp, 950);
        }
      }

      function enterMainApp() {
        if (state.bootCompleted) return;
        state.bootCompleted = true;

        if (!state.activeDohId) {
          state.activeDohId = (getHealthyDohSorted()[0] || state.dohProviders[0]).id;
        }

        dom.bootGate.style.opacity = '0';
        dom.bootGate.style.transform = 'scale(1.02)';
        dom.bootGate.style.pointerEvents = 'none';
        dom.appShell.classList.remove('opacity-0', 'pointer-events-none');
        setTimeout(() => dom.bootGate.classList.add('hidden'), 650);

        renderDohViews();
        loadOfficialPlaylist(state.currentPlaylist);
      }

      async function retestAllDohProviders() {
        showToast('Executando benchmark nos servidores DoH...', 'info');
        await Promise.allSettled(state.dohProviders.map(p => benchmarkDohProvider(p)));
        const healthy = getHealthyDohSorted();
        if (healthy.length > 0) {
          state.activeDohId = healthy[0].id;
          renderDohViews();
          showToast(`${healthy.length} provedor(es) online. Mais rápido: ${healthy[0].name} (${healthy[0].latency} ms)`, 'success');
        } else {
          showToast('Nenhum provedor DoH respondeu neste teste.', 'warning');
        }
      }

      function updateCacheStatsUi() {
        const now = Date.now();
        for (const [k, v] of state.dnsCache.entries()) {
          if (v.expiresAt <= now) state.dnsCache.delete(k);
        }
        const size = state.dnsCache.size;
        dom.cacheMiniIndicator.textContent = `Cache DNS: ${size}`;
        dom.modalCacheStats.textContent = `${size} entrada(s) em cache • ${state.cacheHits} acertos (hits) • ${state.cacheMisses} consultas externas`;
      }

      function updateHeaderDnsBadge() {
        const active = getActiveDohProvider();
        if (!active) return;
        const dotCls = active.status === 'online'
          ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]'
          : active.status === 'offline' ? 'bg-rose-400' : 'bg-cyan-400 animate-pulse';
        dom.headerDnsDot.className = `w-2 h-2 rounded-full ${dotCls}`;
        dom.headerDnsName.textContent = active.name;
        dom.headerDnsLatency.textContent = active.latency ? `${active.latency} ms` : 'DoH';
      }

      function updateTelemetryResolverLine() {
        // Não sobrescreve a linha enquanto há um canal com telemetria própria
        if (state.currentChannelDns) return;
        const active = getActiveDohProvider();
        if (!active) return;
        dom.telemetryResolverLine.textContent = `Resolver ativo: ${active.name}${active.latency ? ` (${active.latency} ms)` : ''}`;
      }

      function renderBootDohList() {
        dom.bootDohList.innerHTML = state.dohProviders.map(p => {
          const isWinner = state.activeDohId === p.id && p.status === 'online';
          let right = '';
          if (p.status === 'testing' || p.status === 'idle') {
            right = `<span class="inline-flex items-center gap-1.5 text-[11px] font-mono text-cyan-400">
              <svg class="w-3 h-3 animate-spin-slow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke-linecap="round"/></svg>Testando</span>`;
          } else if (p.status === 'online') {
            const latColor = p.latency < 220 ? 'text-emerald-400' : p.latency < 550 ? 'text-cyan-400' : 'text-amber-400';
            right = `<div class="flex items-center gap-1.5 flex-wrap justify-end">
              ${p.dnssec ? '<span class="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-400/30">DNSSEC</span>' : ''}
              <span class="font-mono text-[10px] text-sec hidden sm:inline">${escapeHtml(p.resolvedIp || '')}</span>
              <span class="inline-flex items-center gap-1 font-mono text-[11px] font-bold ${latColor} tabular-nums"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>${p.latency} ms</span>
            </div>`;
          } else {
            right = `<span class="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-rose-400"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>Falha</span>`;
          }
          return `
            <div class="flex items-center justify-between gap-2.5 px-3.5 py-2.5 rounded-2xl border transition-all ${isWinner ? 'bg-emerald-500/15 border-emerald-400/50 shadow-md shadow-emerald-500/10' : 'channel-card'}">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-bold truncate">${escapeHtml(p.name)}</span>
                  ${isWinner ? '<span class="px-1.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase bg-emerald-500 text-slate-950">Vencedor</span>' : ''}
                </div>
                <p class="text-[10px] font-mono text-sec truncate">${escapeHtml(p.subtitle || p.template)}</p>
              </div>
              <div class="flex-shrink-0">${right}</div>
            </div>`;
        }).join('');
      }

      function renderModalDohList() {
        dom.modalDohList.innerHTML = state.dohProviders.map(p => {
          const isSelected = state.activeDohId === p.id;
          let badge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-500/15 text-sec">Idle</span>';
          if (p.status === 'testing') badge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-cyan-500/15 text-cyan-400">Testando...</span>';
          else if (p.status === 'online') badge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-400 tabular-nums">${p.latency} ms</span>`;
          else if (p.status === 'offline') badge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-rose-500/15 text-rose-400">Falha</span>';

          return `
            <div class="flex items-center justify-between gap-2.5 p-3 rounded-2xl border transition-all ${isSelected ? 'bg-indigo-500/15 border-indigo-400/55' : 'channel-card'}">
              <button type="button" data-select-doh="${escapeHtml(p.id)}" class="flex-1 text-left flex items-center gap-3 min-w-0">
                <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-cyan-400' : 'border-slate-500'}">
                  ${isSelected ? '<div class="w-2 h-2 rounded-full bg-cyan-400"></div>' : ''}
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="text-xs font-bold truncate">${escapeHtml(p.name)}</span>
                    ${p.dnssec ? '<span class="px-1.5 rounded text-[9px] font-mono font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-400/25">DNSSEC</span>' : ''}
                    ${p.custom ? '<span class="px-1.5 rounded text-[9px] font-semibold bg-cyan-500/15 text-cyan-400">Custom</span>' : ''}
                  </div>
                  <p class="text-[10px] font-mono text-sec truncate">${escapeHtml(p.resolvedIp ? `IP: ${p.resolvedIp} • ` : '')}${escapeHtml(p.template)}</p>
                </div>
              </button>
              <div class="flex items-center gap-1.5 flex-shrink-0">
                ${badge}
                ${p.custom ? `<button type="button" data-remove-doh="${escapeHtml(p.id)}" class="w-7 h-7 rounded-full hover:bg-rose-500/20 text-sec hover:text-rose-400 flex items-center justify-center" title="Remover servidor" aria-label="Remover servidor">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>` : ''}
              </div>
            </div>`;
        }).join('');
      }

      function renderDohViews() {
        renderBootDohList();
        renderModalDohList();
        updateHeaderDnsBadge();
        updateTelemetryResolverLine();
      }

      /* ======================================================================
         CARREGAMENTO DE PLAYLISTS (CDN FAILOVER)
         ====================================================================== */
      // Mantém a assinatura anterior para não alterar a lógica da UI.
      async function fetchOfficialPlaylistWithCdnFailover(fileName) {
        return fetchPlaylistWithFailover(
          CDN_MIRRORS.map(mirror => ({ mirror, url: mirror.buildUrl(fileName) })),
          11000,
        );
      }

      /* ======================================================================
         PARSER M3U / M3U8
         ====================================================================== */
      function parseM3U8(rawText) {
        return parseM3U8Typed(rawText, (host) => {
          if (!state.hostHealthMap.has(host)) {
            state.hostHealthMap.set(host, { ok: true, status: 'IP Direto', ip: host, isDirectIp: true });
          }
        });
      }

      /* ======================================================================
         RENDERIZAÇÃO DO CATÁLOGO
         ====================================================================== */
      function renderPlaylistPills() {
        dom.playlistPills.innerHTML = OFFICIAL_PLAYLISTS.map(pl => {
          const active = state.currentPlaylist && state.currentPlaylist.id === pl.id;
          const icon = pl.id === 'filmes-series'
            ? '<rect x="2" y="2" width="20" height="20" rx="2.2"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/>'
            : '<rect x="2.5" y="6.5" width="19" height="13.5" rx="2.5"/><path d="M16.5 2.5L12 6.5 7.5 2.5"/>';
          return `
            <button type="button" data-playlist-id="${escapeHtml(pl.id)}" class="m3-pill flex-shrink-0 px-3.5 py-2 rounded-full text-xs font-semibold flex items-center gap-1.5 ${active ? 'active' : ''}">
              <svg class="w-3.5 h-3.5 opacity-85" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon}</svg>
              <span>${escapeHtml(pl.name)}</span>
            </button>`;
        }).join('');
      }

      function resetCatalogUi() {
        state.activeCategory = 'Todas';
        state.searchQuery = '';
        dom.searchInput.value = '';
        dom.clearSearchBtn.classList.add('hidden');
        dom.channelList.innerHTML = '';
        dom.categoryChips.innerHTML = '';
        dom.listEmptyState.classList.add('hidden');
        dom.loadMoreContainer.classList.add('hidden');
        dom.listLoadingState.classList.remove('hidden');
      }

      async function loadOfficialPlaylist(playlistObj) {
        if (playlistObj.combine) return loadUnifiedPlaylist(playlistObj);
        stopBatchAuditIfRunning();
        const seq = ++state.playlistLoadSeq;
        state.currentPlaylist = playlistObj;
        dom.currentPlaylistName.textContent = playlistObj.name;
        dom.channelCounter.textContent = 'Buscando via CDN direta...';
        dom.cdnOriginStatus.textContent = `Resolvendo e baixando ${playlistObj.file}...`;
        renderPlaylistPills();
        resetCatalogUi();

        try {
          const { text, mirror } = await fetchPlaylistSource(playlistObj);
          if (seq !== state.playlistLoadSeq) return;
          const parsed = parseM3U8(text);
          state.allChannels = parsed;
          dom.listLoadingState.classList.add('hidden');
          dom.cdnOriginStatus.textContent = `Origem direta: ${mirror.label} • ${playlistObj.file}`;
          buildCategoryChips();
          applyFiltersAndRender();
          showToast(`${parsed.length.toLocaleString('pt-BR')} itens carregados (${mirror.label})`, 'success');
        } catch (err) {
          if (seq !== state.playlistLoadSeq) return;
          console.error('Erro ao carregar playlist:', err);
          state.allChannels = [];
          state.filteredChannels = [];
          dom.listLoadingState.classList.add('hidden');
          dom.channelCounter.textContent = 'Erro ao carregar lista';
          dom.cdnOriginStatus.textContent = 'Falha nos espelhos CDN diretos';
          dom.listEmptyState.classList.remove('hidden');
          dom.emptyStateTitle.textContent = 'Não foi possível carregar esta lista';
          dom.emptyStateDesc.textContent = 'Fonte indisponível, lenta ou bloqueada por CORS. Tente outra lista ou importe um arquivo M3U local.';
          dom.retryPlaylistBtn.classList.remove('hidden');
          showToast('Falha ao baixar lista nos espelhos CDN.', 'error');
        }
      }

      async function loadExternalUrlPlaylist(url) {
        stopBatchAuditIfRunning();
        const seq = ++state.playlistLoadSeq;
        const host = extractHostname(url);
        state.currentPlaylist = { id: 'custom-url', name: host || 'Lista Externa', file: '', url };
        dom.currentPlaylistName.textContent = state.currentPlaylist.name;
        dom.channelCounter.textContent = 'Baixando playlist...';
        renderPlaylistPills();
        resetCatalogUi();

        try {
          const text = await fetchPlaylistText(url, null, 12000);
          if (seq !== state.playlistLoadSeq) return;
          const parsed = parseM3U8(text);
          if (!parsed.length) throw new Error('Nenhum stream válido encontrado nesta URL.');
          state.allChannels = parsed;
          state.extraCatalogs = [...state.extraCatalogs.filter(x => x.name !== state.currentPlaylist.name), { name: state.currentPlaylist.name, channels: parsed }].slice(-4);
          dom.listLoadingState.classList.add('hidden');
          dom.cdnOriginStatus.textContent = 'Origem externa direta: ' + host;
          buildCategoryChips();
          applyFiltersAndRender();
          showToast(parsed.length.toLocaleString('pt-BR') + ' itens importados!', 'success');
          // Diagnóstico paralelo, sem impedir importação funcional.
          if (host && !isIpAddress(host)) resolveDns(host, 'A').catch(() => {});
        } catch (err) {
          if (seq !== state.playlistLoadSeq) return;
          state.allChannels = [];
          state.filteredChannels = [];
          dom.listLoadingState.classList.add('hidden');
          dom.channelCounter.textContent = 'Erro ao importar';
          dom.listEmptyState.classList.remove('hidden');
          dom.emptyStateTitle.textContent = 'Falha ao importar URL externa';
          dom.emptyStateDesc.textContent = /fetch|cors|network|abort/i.test(err.message)
            ? 'O servidor não permitiu leitura CORS, a conexão falhou ou expirou. Baixe a lista e importe o arquivo localmente.'
            : err.message;
          dom.retryPlaylistBtn.classList.add('hidden');
          showToast('Erro ao importar lista externa.', 'error');
        }
      }



      function loadLocalPlaylistText(name, rawText) {
        stopBatchAuditIfRunning();
        state.playlistLoadSeq++;
        state.currentPlaylist = { id: 'custom-local', name, file: '' };
        dom.currentPlaylistName.textContent = name;
        renderPlaylistPills();
        resetCatalogUi();

        if (rawText.length > MAX_PLAYLIST_BYTES) { showToast("Lista local excede o limite de 12 MB.", "error"); dom.listLoadingState.classList.add("hidden"); return; }
        const parsed = parseM3U8(rawText);
        state.allChannels = parsed;
        state.extraCatalogs = [...state.extraCatalogs.filter(x => x.name !== name), { name, channels: parsed }].slice(-4);
        dom.listLoadingState.classList.add('hidden');
        dom.cdnOriginStatus.textContent = `Arquivo local: ${name}`;
        buildCategoryChips();
        applyFiltersAndRender();
        if (parsed.length) showToast(`${parsed.length.toLocaleString('pt-BR')} itens carregados do arquivo local!`, 'success');
        else showToast('Nenhum stream válido encontrado no arquivo.', 'warning');
      }

      function buildCategoryChips() {
        const counts = new Map();
        for (const ch of state.allChannels) {
          const grp = ch.group || 'Geral';
          counts.set(grp, (counts.get(grp) || 0) + 1);
        }
        const topGroups = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 60);
        const chips = [{ name: 'Todas', count: state.allChannels.length }, ...topGroups.map(([name, count]) => ({ name, count }))];

        dom.categoryChips.innerHTML = chips.map(cat => {
          const active = state.activeCategory === cat.name;
          return `<button type="button" data-category="${escapeHtml(cat.name)}" class="m3-pill flex-shrink-0 px-3 py-1.5 rounded-full text-[11px] font-semibold ${active ? 'active' : ''}">
            ${escapeHtml(cat.name)} <span class="opacity-70 font-mono text-[10px] ml-0.5">${cat.count}</span></button>`;
        }).join('');
      }

      function updateFavBadge() {
        dom.favCountBadge.textContent = Object.keys(state.favorites).length;
      }

      function applyFiltersAndRender() {
        updateFavBadge();
        const q = state.searchQuery.trim().toLowerCase();
        const source = state.activeTab === 'favorites' ? Object.values(state.favorites) : state.allChannels;

        state.filteredChannels = source.filter(ch => {
          if (state.activeTab === 'all' && state.activeCategory !== 'Todas' && ch.group !== state.activeCategory) return false;
          if (state.onlyActiveDns) {
            const h = state.hostHealthMap.get(ch.host || extractHostname(ch.url));
            if (!h || !h.ok) return false;
          }
          if (q && !(ch.searchKey || `${ch.name} ${ch.group}`.toLowerCase()).includes(q)) return false;
          return true;
        });

        state.renderedCount = 0;
        dom.channelList.innerHTML = '';
        dom.channelListContainer.scrollTop = 0;

        const total = state.filteredChannels.length;
        dom.channelCounter.textContent = `${total.toLocaleString('pt-BR')} ${total === 1 ? 'canal' : 'canais'}${state.onlyActiveDns ? ' (DNS ativo)' : ''}`;

        if (total === 0) {
          dom.loadMoreContainer.classList.add('hidden');
          dom.listEmptyState.classList.remove('hidden');
          dom.retryPlaylistBtn.classList.add('hidden');
          if (state.onlyActiveDns) {
            dom.emptyStateTitle.textContent = 'Nenhum canal com DNS validado ainda';
            dom.emptyStateDesc.textContent = 'Clique em "Auditar DNS" acima para validar todos os domínios desta lista em lote.';
          } else if (state.activeTab === 'favorites') {
            dom.emptyStateTitle.textContent = 'Nenhum favorito salvo';
            dom.emptyStateDesc.textContent = 'Toque no coração em qualquer canal para fixá-lo nos seus favoritos.';
          } else {
            dom.emptyStateTitle.textContent = 'Nenhum resultado encontrado';
            dom.emptyStateDesc.textContent = 'Tente outro termo na busca ou selecione "Todas" nas categorias.';
          }
          return;
        }

        dom.listEmptyState.classList.add('hidden');
        renderNextBatch();
      }

      function getHostStatusDotHtml(host) {
        const info = state.hostHealthMap.get(host);
        if (!info) return '<span class="w-2 h-2 rounded-full bg-slate-500/45 flex-shrink-0" title="DNS não auditado ainda"></span>';
        if (info.ok) {
          const label = info.isDirectIp ? 'IP literal (serviço não testado)' : `DNS resolvido (${info.ip || info.status}); stream não testado`;
          return `<span class="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.85)] flex-shrink-0" title="${escapeHtml(label)}"></span>`;
        }
        return `<span class="w-2 h-2 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.8)] flex-shrink-0" title="Falha na consulta DNS (${escapeHtml(info.status)})"></span>`;
      }

      const FALLBACK_LOGO_SVG = `<svg class="w-5 h-5 text-sec" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="6.5" width="19" height="13.5" rx="2.5"/><path d="M16.5 2.5L12 6.5 7.5 2.5"/></svg>`;

      function renderNextBatch() {
        const start = state.renderedCount;
        const end = Math.min(start + PAGE_SIZE, state.filteredChannels.length);
        if (start >= end) {
          dom.loadMoreContainer.classList.add('hidden');
          return;
        }

        const fragment = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
          const ch = state.filteredChannels[i];
          const host = ch.host || extractHostname(ch.url);
          const isPlaying = state.currentChannel && state.currentChannel.url === ch.url;
          const isFav = Boolean(state.favorites[ch.url]);

          const row = document.createElement('div');
          row.className = `channel-card rounded-2xl p-2.5 flex items-center gap-3 cursor-pointer ${isPlaying ? 'playing' : ''}`;
          row.dataset.channelIndex = String(i);

          const logoHtml = ch.logo
            ? `<img src="${escapeHtml(ch.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" class="w-full h-full object-contain p-1" data-logo-img /><div style="display:none" class="w-full h-full items-center justify-center">${FALLBACK_LOGO_SVG}</div>`
            : `<div class="w-full h-full flex items-center justify-center">${FALLBACK_LOGO_SVG}</div>`;

          row.innerHTML = `
            <div class="w-11 h-11 rounded-xl bg-slate-900/10 dark:bg-black/40 border themed-divider overflow-hidden flex-shrink-0 flex items-center justify-center">${logoHtml}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span data-dns-dot="${escapeHtml(host)}" class="inline-flex items-center">${getHostStatusDotHtml(host)}</span>
                <p class="text-xs sm:text-[13px] font-bold truncate">${escapeHtml(ch.name)}</p>
                ${isPlaying ? '<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 live-dot flex-shrink-0"></span>' : ''}
              </div>
              <p class="text-[11px] text-sec truncate mt-0.5">${escapeHtml(ch.group || 'Geral')}${ch.source ? ' • ' + escapeHtml(ch.source) : ''} <span class="opacity-60 font-mono text-[10px]">• ${escapeHtml(host || 'stream')}</span></p>
            </div>
            <button type="button" data-fav-url="${escapeHtml(ch.url)}" data-fav-idx="${i}"
              class="m3-btn w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${isFav ? 'text-rose-400 bg-rose-500/15' : 'text-ter hover:text-indigo-400 hover:bg-slate-500/10'}"
              title="${isFav ? 'Remover dos favoritos' : 'Salvar nos favoritos'}" aria-label="Favoritar">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
            </button>`;

          const castRow = document.createElement('button');
          castRow.type = 'button';
          castRow.dataset.wvcIndex = String(i);
          castRow.textContent = '📺';
          castRow.title = 'Abrir no Web Video Caster';
          castRow.setAttribute('aria-label', 'Abrir no Web Video Caster');
          castRow.className = 'm3-btn w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 hover:bg-cyan-500/20';
          row.querySelector('button[data-fav-url]').before(castRow);
          const img = row.querySelector('img[data-logo-img]');
          if (img) {
            img.addEventListener('error', () => {
              img.style.display = 'none';
              if (img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
            }, { once: true });
          }
          fragment.appendChild(row);
        }

        dom.channelList.appendChild(fragment);
        state.renderedCount = end;

        const remaining = state.filteredChannels.length - state.renderedCount;
        if (remaining > 0) {
          dom.loadMoreContainer.classList.remove('hidden');
          dom.loadMoreBtn.textContent = `Carregar mais (${remaining.toLocaleString('pt-BR')} restantes)`;
        } else {
          dom.loadMoreContainer.classList.add('hidden');
        }
      }

      function refreshRenderedHostDots(host) {
        if (!host) return;
        const html = getHostStatusDotHtml(host);
        dom.channelList.querySelectorAll(`[data-dns-dot="${CSS.escape(host)}"]`).forEach(el => { el.innerHTML = html; });
      }

      /* ======================================================================
         AUDITORIA DNS EM LOTE
         ====================================================================== */
      function stopBatchAuditIfRunning() {
        if (state.batchAuditing) state.batchAbortFlag = true;
      }

      async function runBatchDnsAudit() {
        if (state.batchAuditing) {
          state.batchAbortFlag = true;
          showToast('Cancelando auditoria DNS...', 'info');
          return;
        }

        const source = state.activeTab === 'favorites' ? Object.values(state.favorites) : state.allChannels;
        if (!source.length) {
          showToast('Carregue uma lista de canais antes de auditar.', 'warning');
          return;
        }

        const uniqueHosts = Array.from(new Set(source.map(ch => ch.host || extractHostname(ch.url)).filter(Boolean)));
        if (!uniqueHosts.length) return;

        state.batchAuditing = true;
        state.batchAbortFlag = false;
        dom.batchAuditLabel.textContent = 'Parar Auditoria';
        dom.batchAuditIcon.classList.add('animate-spin-slow');
        dom.batchAuditProgressBox.classList.remove('hidden');

        let completed = 0, onlineHosts = 0, offlineHosts = 0, cursor = 0;
        const total = uniqueHosts.length;

        const updateProgress = () => {
          dom.batchAuditBar.style.width = `${Math.round((completed / total) * 100)}%`;
          dom.batchAuditStats.textContent = `${completed}/${total} domínios`;
          dom.batchAuditText.textContent = `Ativos: ${onlineHosts} • Offline: ${offlineHosts}`;
        };
        updateProgress();

        async function worker() {
          while (!state.batchAbortFlag) {
            const idx = cursor++;
            if (idx >= total) break;
            const host = uniqueHosts[idx];

            if (isIpAddress(host)) {
              state.hostHealthMap.set(host, { ok: true, status: 'IP Direto', ip: host, isDirectIp: true });
              onlineHosts++;
            } else {
              try {
                const res = await resolveDns(host, 'A');
                const ip = res.answers.find(a => a.type === DNS_TYPE_NUM.A || a.type === DNS_TYPE_NUM.CNAME)?.data || '';
                const ok = res.statusCode === 0 && res.answers.length > 0;
                state.hostHealthMap.set(host, { ok, status: res.statusText, ip, isDirectIp: false });
                if (ok) onlineHosts++; else offlineHosts++;
              } catch {
                state.hostHealthMap.set(host, { ok: false, status: 'ERRO', ip: '', isDirectIp: false });
                offlineHosts++;
              }
            }
            completed++;
            refreshRenderedHostDots(host);
            updateProgress();
          }
        }

        await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, total) }, () => worker()));

        const aborted = state.batchAbortFlag;
        state.batchAuditing = false;
        state.batchAbortFlag = false;
        dom.batchAuditLabel.textContent = 'Auditar DNS';
        dom.batchAuditIcon.classList.remove('animate-spin-slow');

        if (aborted) {
          dom.batchAuditText.textContent = `Auditoria pausada (${onlineHosts} ativos, ${offlineHosts} offline)`;
        } else {
          dom.batchAuditText.textContent = `Concluída: ${onlineHosts} ativos • ${offlineHosts} offline`;
          showToast(`Auditoria DNS concluída: ${onlineHosts} ativos, ${offlineHosts} offline`, 'success');
        }
        if (state.onlyActiveDns) applyFiltersAndRender();
      }

      /* ======================================================================
         FAVORITOS
         ====================================================================== */
      function toggleFavorite(channel) {
        if (!channel || !channel.url) return;
        if (state.favorites[channel.url]) {
          delete state.favorites[channel.url];
          showToast(`"${channel.name}" removido dos favoritos`, 'info');
        } else {
          state.favorites[channel.url] = {
            id: channel.id, name: channel.name, tvgName: channel.tvgName || '', logo: channel.logo || '',
            group: channel.group || 'Geral', url: channel.url, host: channel.host || extractHostname(channel.url),
            searchKey: `${channel.name} ${channel.tvgName || ''} ${channel.group} ${channel.host || ''}`.toLowerCase(),
          };
          showToast(`"${channel.name}" salvo nos favoritos`, 'success');
        }
        saveJsonStorage(STORAGE_KEYS.FAVORITES, state.favorites);
        updateFavBadge();
        updatePlayerFavIcon();

        if (state.activeTab === 'favorites') {
          applyFiltersAndRender();
        } else {
          const isFav = Boolean(state.favorites[channel.url]);
          dom.channelList.querySelectorAll('button[data-fav-url]').forEach(btn => {
            if (btn.dataset.favUrl !== channel.url) return;
            btn.className = `m3-btn w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${isFav ? 'text-rose-400 bg-rose-500/15' : 'text-ter hover:text-indigo-400 hover:bg-slate-500/10'}`;
            const svg = btn.querySelector('svg');
            if (svg) svg.setAttribute('fill', isFav ? 'currentColor' : 'none');
          });
        }
      }

      /* ======================================================================
         PLAYER
         ====================================================================== */
      function destroyCurrentHls() {
        if (state.hlsInstance) {
          try { state.hlsInstance.destroy(); } catch {}
          state.hlsInstance = null;
        }
        state.suppressVideoError = true;
        dom.video.pause();
        dom.video.removeAttribute('src');
        dom.video.load();
        setTimeout(() => { state.suppressVideoError = false; }, 0);
      }

      function setStreamStatus(mode, text = '') {
        const b = dom.streamStatusBadge;
        const base = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] backdrop-blur-md border ';
        if (mode === 'live') {
          b.className = base + 'font-bold bg-emerald-500/20 border-emerald-400/40 text-emerald-200';
          b.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot"></span>AO VIVO';
        } else if (mode === 'buffering') {
          b.className = base + 'font-semibold bg-cyan-500/20 border-cyan-400/35 text-cyan-200';
          b.innerHTML = '<svg class="w-3 h-3 animate-spin-slow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke-linecap="round"/></svg>CARREGANDO';
        } else if (mode === 'error') {
          b.className = base + 'font-bold bg-rose-500/20 border-rose-400/40 text-rose-200';
          b.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>INDISPONÍVEL';
        } else {
          b.className = base + 'font-semibold bg-white/10 border-white/15 text-slate-200';
          b.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span>${escapeHtml(text || 'AGUARDANDO')}`;
        }
      }

      function updatePlayerFavIcon() {
        const isFav = Boolean(state.currentChannel && state.favorites[state.currentChannel.url]);
        dom.ctrlFavIcon.setAttribute('fill', isFav ? 'currentColor' : 'none');
        dom.ctrlFavBtn.classList.toggle('text-rose-400', isFav);
        dom.ctrlFavBtn.classList.toggle('text-slate-200', !isFav);
      }

      function updateLiveDnsTelemetryBar(d) {
        if (!d) return;
        dom.telHostname.textContent = d.host || '—';
        dom.telHostname.title = d.host || '';

        const ipDisplay = d.ipv4.length
          ? `${d.ipv4[0]}${d.ipv6.length ? ' (+IPv6)' : ''}`
          : d.ipv6.length ? d.ipv6[0] : d.ok ? 'Resolvido' : 'Sem IP';
        dom.telIp.textContent = ipDisplay;
        dom.telIp.title = [...d.ipv4, ...d.ipv6].join(', ') || ipDisplay;

        const cnamePart = d.cname.length ? `${d.cname[0]} • ` : '';
        const ttlPart = d.ttl ? `TTL ${d.ttl}s` : (d.isDirectIp ? 'IP Literal' : '—');
        dom.telTtl.textContent = `${cnamePart}${ttlPart}`;
        dom.telTtl.title = `${cnamePart}${ttlPart}`;

        dom.telLatency.textContent = d.isDirectIp ? '0 ms (Direto)' : d.fromCache ? '0 ms (Cache)' : `${d.latency} ms`;
        dom.telemetryResolverLine.textContent = `Resolver: ${d.resolverName}${d.fromCache ? ' • Resposta em Cache' : ''}`;
        dom.telemetryStatusChip.textContent = d.statusText;

        const pillBase = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono backdrop-blur-md border ';
        if (d.ok) {
          dom.telemetryStatusChip.className = 'px-2.5 py-1 rounded-full text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-500 dark:text-emerald-300 border border-emerald-400/30';
          dom.streamDnsPill.textContent = d.isDirectIp ? 'IP Direto' : `${d.statusText} • ${d.ipv4[0] || d.ipv6[0] || 'OK'}`;
          dom.streamDnsPill.className = pillBase + 'bg-emerald-500/20 border-emerald-400/35 text-emerald-200';
        } else {
          dom.telemetryStatusChip.className = 'px-2.5 py-1 rounded-full text-[10px] font-mono font-bold bg-rose-500/15 text-rose-400 border border-rose-400/30';
          dom.streamDnsPill.textContent = `DNS ${d.statusText}`;
          dom.streamDnsPill.className = pillBase + 'bg-rose-500/20 border-rose-400/35 text-rose-200';
        }
        dom.telemetryDnssecChip.classList.toggle('hidden', !d.dnssec);
      }

      function showDiagnosticError(kind, title, detail) {
        destroyCurrentHls();
        dom.playerLoadingOverlay.classList.add('hidden');
        dom.playerErrorOverlay.classList.remove('hidden');
        setStreamStatus('error');

        const tagStyles = {
          dns: { text: 'DIAGNÓSTICO DNS • DOMÍNIO OFFLINE', cls: 'bg-rose-500/20 text-rose-300 border-rose-400/35' },
          mixed: { text: 'MIXED CONTENT • HTTP EM PÁGINA HTTPS', cls: 'bg-amber-500/20 text-amber-300 border-amber-400/35' },
          cors: { text: 'BLOQUEIO CORS NA ORIGEM DO CANAL', cls: 'bg-amber-500/20 text-amber-300 border-amber-400/35' },
          media: { text: 'ERRO DE REDE / DECODIFICAÇÃO', cls: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/35' },
        };
        const style = tagStyles[kind] || tagStyles.media;
        dom.errorCategoryTag.textContent = style.text;
        dom.errorCategoryTag.className = `px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border mb-1.5 ${style.cls}`;
        dom.errorTitle.textContent = title;
        dom.errorDetail.textContent = detail;
        dom.errorExternalLink.href = state.currentChannel ? state.currentChannel.url : '#';

        const canTryHttps = Boolean(state.currentChannel && /^http:\/\//i.test(state.currentChannel.url));
        dom.errorTryHttpsBtn.classList.toggle('hidden', !canTryHttps);
      }

      // Biblioteca sob demanda para reduzir o peso da primeira tela (~nenhum JS de vídeo no boot).
      // O motor HLS é importado de forma dinâmica em src/player/hls-loader.ts.

      async function playChannel(channel) {
        if (!channel || !channel.url) return;
        const playSeq = ++state.streamPlaybackSeq;
        state.currentChannel = channel;
        state.currentChannelDns = null;
        state.hlsRetryCount = 0;
        highlightPlayingCard(channel.url);
        updatePlayerFavIcon();
        dom.playerIdleOverlay.classList.add('hidden');
        dom.playerErrorOverlay.classList.add('hidden');
        dom.playerLoadingOverlay.classList.remove('hidden');
        dom.playerTitle.textContent = channel.name;
        dom.playerGroup.textContent = channel.group || 'zPLAYER';
        dom.playerLoadingText.textContent = 'Abrindo stream diretamente na origem...';
        setStreamStatus('buffering');
        destroyCurrentHls();

        dom.playerLogoBox.innerHTML = '';
        const fallbackIcon = '<svg class="w-5 h-5 text-cyan-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="6.5" width="19" height="13.5" rx="3"/><path d="M16.5 2.5L12 6.5 7.5 2.5"/></svg>';
        if (channel.logo) {
          const img = document.createElement('img');
          img.src = channel.logo;
          img.alt = '';
          img.referrerPolicy = 'no-referrer';
          img.className = 'w-full h-full object-contain p-1';
          img.addEventListener('error', () => { dom.playerLogoBox.innerHTML = fallbackIcon; }, { once: true });
          dom.playerLogoBox.appendChild(img);
        } else dom.playerLogoBox.innerHTML = fallbackIcon;
        if (window.innerWidth < 1024) dom.playerWrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // A consulta DoH apenas diagnostica: ela não resolve a conexão do vídeo nem bloqueia a reprodução.
        preflightChannelDns(channel.url).then(info => {
          if (playSeq !== state.streamPlaybackSeq) return;
          state.currentChannelDns = info;
          updateLiveDnsTelemetryBar(info);
          refreshRenderedHostDots(info.host);
        }).catch(err => {
          if (playSeq === state.streamPlaybackSeq) console.info('Diagnóstico DoH indisponível:', err.message);
        });
        const mixed = location.protocol === 'https:' && channel.url.toLowerCase().startsWith('http:');
        void startDirectPlayback(channel.url, mixed);
      }

      async function startDirectPlayback(streamUrl, isMixedContent) {
        const playSeq = state.streamPlaybackSeq;
        destroyCurrentHls();
        if (isMixedContent) {
          showDiagnosticError('mixed', 'HTTP bloqueado em página HTTPS',
            'O navegador não permite este stream HTTP nesta origem HTTPS. Use a opção Tentar HTTPS se o servidor oferecer suporte, ou abra em um player externo. DoH não contorna esta restrição.');
          return;
        }
        const directMedia = /\.(mp4|webm|ogg|mov)(\?|#|$)/i.test(streamUrl);
        if (directMedia || (dom.video.canPlayType('application/vnd.apple.mpegurl') && /Safari/i.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg/i.test(navigator.userAgent))) {
          dom.video.src = streamUrl;
          dom.video.play().catch(() => {
            if (playSeq === state.streamPlaybackSeq) {
              dom.playerLoadingOverlay.classList.add('hidden');
              showToast('Use o botão Reproduzir para iniciar o vídeo.', 'info');
            }
          });
          return;
        }
        let Hls;
        try {
          dom.playerLoadingText.textContent = 'Preparando motor HLS no navegador...';
          Hls = await loadHlsLibrary();
        } catch (error) {
          if (playSeq === state.streamPlaybackSeq) showDiagnosticError('media', 'Biblioteca HLS indisponível', error.message);
          return;
        }
        if (playSeq !== state.streamPlaybackSeq) return;
        if (!Hls.isSupported()) {
          showDiagnosticError('media', 'HLS incompatível', 'Este navegador não oferece MediaSource nem HLS nativo. Envie o vídeo ao Web Video Caster ou tente outro navegador.');
          return;
        }
        const hls = new Hls({
          enableWorker: true, lowLatencyMode: true, capLevelToPlayerSize: true,
          backBufferLength: 30, maxBufferLength: 30, maxBufferSize: 50 * 1024 * 1024,
          liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 10,
        });
        state.hlsInstance = hls;
        let networkRetries = 0;
        let mediaRetries = 0;
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          if (playSeq === state.streamPlaybackSeq) hls.loadSource(streamUrl);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (playSeq !== state.streamPlaybackSeq) return;
          dom.playerLoadingText.textContent = 'Iniciando reprodução...';
          dom.video.play().catch(() => {
            if (playSeq === state.streamPlaybackSeq) {
              dom.playerLoadingOverlay.classList.add('hidden');
              showToast('Clique em Reproduzir para iniciar.', 'info');
            }
          });
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || playSeq !== state.streamPlaybackSeq) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 2) {
            dom.playerLoadingText.textContent = 'Recuperando decodificação...';
            hls.recoverMediaError();
            return;
          }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries++ < 2) {
            dom.playerLoadingText.textContent = 'Reconectando à origem do canal...';
            setTimeout(() => {
              if (playSeq === state.streamPlaybackSeq && state.hlsInstance === hls) hls.startLoad();
            }, 800 * networkRetries);
            return;
          }
          const code = data.response?.code || data.response?.status || 0;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !code) {
            showDiagnosticError('cors', 'Stream inacessível no navegador',
              'A origem recusou a conexão, não respondeu ou bloqueou as requisições HLS por CORS. O diagnóstico DNS não remove essas restrições. Se estiver no celular, experimente o botão WVC para abrir no Web Video Caster.');
          } else {
            showDiagnosticError('media', code ? 'Servidor retornou HTTP ' + code : 'Falha de decodificação',
              'Detalhe técnico: ' + (data.details || 'Erro fatal na reprodução') + '. Tente recarregar o sinal.');
          }
        });
        hls.attachMedia(dom.video);
      }



      function highlightPlayingCard(url) {
        dom.channelList.querySelectorAll('.channel-card.playing').forEach(el => el.classList.remove('playing'));
        const idx = state.filteredChannels.findIndex(c => c.url === url);
        if (idx !== -1) {
          const card = dom.channelList.querySelector(`.channel-card[data-channel-index="${idx}"]`);
          if (card) card.classList.add('playing');
        }
      }

      /* ======================================================================
         LOOKUP MANUAL
         ====================================================================== */
      async function runManualLookup(domainRaw, type) {
        const domain = extractHostname(/^https?:\/\//i.test(domainRaw.trim()) ? domainRaw.trim() : 'https://' + domainRaw.trim());
        if (!domain) return;

        dom.lookupSubmitBtn.disabled = true;
        dom.lookupSubmitBtn.textContent = 'Consultando...';
        dom.lookupResultBox.classList.remove('hidden');
        dom.lookupRecordsSummary.innerHTML = '<span class="text-xs text-cyan-400 font-mono">Consultando API DoH...</span>';
        dom.lookupJsonOutput.textContent = '';

        try {
          const res = await resolveDns(domain, type, { bypassCache: true });
          const chips = [
            `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${res.statusCode === 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}">${escapeHtml(res.statusText)}</span>`,
            `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-indigo-500/20 text-indigo-400 dark:text-cyan-300">${escapeHtml(res.resolverName)} • ${res.latency} ms</span>`,
          ];
          if (res.dnssec) chips.push('<span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400">DNSSEC (AD)</span>');
          res.answers.forEach(a => {
            chips.push(`<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-500/20">${escapeHtml(a.data)} (TTL ${escapeHtml(a.TTL)}s)</span>`);
          });
          dom.lookupRecordsSummary.innerHTML = chips.join('');
          dom.lookupJsonOutput.textContent = JSON.stringify(res.rawJson, null, 2);
        } catch (err) {
          dom.lookupRecordsSummary.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-rose-500/20 text-rose-400">Erro: ${escapeHtml(err.message)}</span>`;
        } finally {
          dom.lookupSubmitBtn.disabled = false;
          dom.lookupSubmitBtn.textContent = 'Consultar';
        }
      }

      /* ======================================================================
         MODAIS E ABAS (escopo de módulo)
         ====================================================================== */
      function openDnsModal() {
        renderModalDohList();
        updateCacheStatsUi();
        dom.dnsModal.classList.remove('hidden');
      }
      function closeDnsModal() { dom.dnsModal.classList.add('hidden'); }
      function openImportModal() { dom.importModal.classList.remove('hidden'); }
      function closeImportModal() { dom.importModal.classList.add('hidden'); }

      function updateTabButtons() {
        const isAll = state.activeTab === 'all';
        dom.tabAllBtn.className = `m3-btn px-3 py-1 rounded-full text-xs font-semibold ${isAll ? 'bg-indigo-500 text-white shadow-sm' : 'text-sec hover:text-indigo-400'}`;
        dom.tabFavBtn.className = `m3-btn px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1 ${!isAll ? 'bg-rose-500 text-white shadow-sm' : 'text-sec hover:text-rose-400'}`;
        dom.categoryChips.classList.toggle('hidden', !isAll);
      }

      /* ======================================================================
         EVENTOS
         ====================================================================== */
      function bindVideoEvents() {
        const v = dom.video;

        v.addEventListener('playing', () => {
          dom.playerLoadingOverlay.classList.add('hidden');
          dom.playerErrorOverlay.classList.add('hidden');
          dom.iconPlay.classList.add('hidden');
          dom.iconPause.classList.remove('hidden');
          setStreamStatus('live');
        });
        v.addEventListener('pause', () => {
          dom.iconPlay.classList.remove('hidden');
          dom.iconPause.classList.add('hidden');
        });
        v.addEventListener('waiting', () => {
          if (state.currentChannel && dom.playerErrorOverlay.classList.contains('hidden')) {
            dom.playerLoadingOverlay.classList.remove('hidden');
            setStreamStatus('buffering');
          }
        });
        v.addEventListener('error', () => {
          if (state.suppressVideoError || !state.currentChannel || state.hlsInstance) return;
          if (!v.getAttribute('src')) return;
          const isMixed = window.location.protocol === 'https:' && /^http:\/\//i.test(state.currentChannel.url);
          if (isMixed) {
            showDiagnosticError('mixed', 'Bloqueio Mixed Content (HTTP)', 'Streams HTTP diretos são bloqueados em páginas HTTPS. Tente HTTPS ou copie o link para abrir no VLC ou TiviMate.');
          } else {
            showDiagnosticError('cors', 'Erro ao reproduzir mídia direta', 'O servidor de mídia está indisponível, recusou a conexão ou não oferece formato compatível. Tente copiar o link para um player externo.');
          }
        });
        v.addEventListener('volumechange', () => {
          const muted = v.muted || v.volume === 0;
          dom.iconVolOn.classList.toggle('hidden', muted);
          dom.iconVolOff.classList.toggle('hidden', !muted);
          dom.ctrlVolumeSlider.value = muted ? 0 : v.volume;
        });

        let hideTimer = null;
        const wakeControls = () => {
          dom.playerWrapper.classList.add('controls-visible');
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => {
            if (!v.paused) dom.playerWrapper.classList.remove('controls-visible');
          }, 3400);
        };
        dom.playerWrapper.addEventListener('mousemove', wakeControls);
        dom.playerWrapper.addEventListener('touchstart', wakeControls, { passive: true });
      }

      function bindUiEvents() {
        dom.bootEnterNowBtn.addEventListener('click', enterMainApp);

        dom.toggleThemeBtn.addEventListener('click', () => {
          state.theme = state.theme === 'dark' ? 'light' : 'dark';
          applyThemeAndSurface();
          showToast(state.theme === 'dark' ? 'Modo Escuro ativado' : 'Modo Claro ativado', 'info');
        });

        dom.toggleSolidBtn.addEventListener('click', () => {
          state.solidMode = !state.solidMode;
          applyThemeAndSurface();
          showToast(state.solidMode ? 'Modo Sólido ativado (transparências desativadas)' : 'Modo Liquid Glass ativado', 'info');
        });

        dom.playlistPills.addEventListener('click', (e) => {
          const btn = e.target.closest('button[data-playlist-id]');
          if (!btn) return;
          const pl = OFFICIAL_PLAYLISTS.find(p => p.id === btn.dataset.playlistId);
          if (pl) {
            state.activeTab = 'all';
            updateTabButtons();
            loadOfficialPlaylist(pl);
          }
        });

        dom.tabAllBtn.addEventListener('click', () => { state.activeTab = 'all'; updateTabButtons(); applyFiltersAndRender(); });
        dom.tabFavBtn.addEventListener('click', () => { state.activeTab = 'favorites'; updateTabButtons(); applyFiltersAndRender(); });

        let searchTimer = null;
        dom.searchInput.addEventListener('input', (e) => {
          state.searchQuery = e.target.value;
          dom.clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
          clearTimeout(searchTimer);
          searchTimer = setTimeout(applyFiltersAndRender, 110);
        });
        dom.clearSearchBtn.addEventListener('click', () => {
          state.searchQuery = '';
          dom.searchInput.value = '';
          dom.clearSearchBtn.classList.add('hidden');
          applyFiltersAndRender();
          dom.searchInput.focus();
        });

        dom.batchAuditBtn.addEventListener('click', runBatchDnsAudit);
        dom.onlyActiveDnsSwitch.addEventListener('click', () => {
          state.onlyActiveDns = !state.onlyActiveDns;
          dom.onlyActiveDnsSwitch.classList.toggle('on', state.onlyActiveDns);
          dom.onlyActiveDnsSwitch.setAttribute('aria-checked', String(state.onlyActiveDns));
          applyFiltersAndRender();
        });

        dom.categoryChips.addEventListener('click', (e) => {
          const btn = e.target.closest('button[data-category]');
          if (!btn) return;
          state.activeCategory = btn.dataset.category;
          buildCategoryChips();
          applyFiltersAndRender();
        });

        dom.channelList.addEventListener('click', (e) => {
          const wvcBtn = e.target.closest('button[data-wvc-index]');
          if (wvcBtn) {
            e.stopPropagation();
            const channel = state.filteredChannels[Number(wvcBtn.dataset.wvcIndex)];
            if (channel) openInWebVideoCaster(channel);
            return;
          }
          const favBtn = e.target.closest('button[data-fav-url]');
          if (favBtn) {
            e.stopPropagation();
            const ch = state.filteredChannels[Number(favBtn.dataset.favIdx)];
            if (ch) toggleFavorite(ch);
            return;
          }
          const card = e.target.closest('.channel-card');
          if (!card) return;
          const ch = state.filteredChannels[Number(card.dataset.channelIndex)];
          if (ch) playChannel(ch);
        });

        dom.loadMoreBtn.addEventListener('click', renderNextBatch);
        dom.channelListContainer.addEventListener('scroll', () => {
          const el = dom.channelListContainer;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) renderNextBatch();
        });

        dom.retryPlaylistBtn.addEventListener('click', () => {
          if (state.currentPlaylist && (state.currentPlaylist.file || state.currentPlaylist.url || state.currentPlaylist.combine)) loadOfficialPlaylist(state.currentPlaylist);
        });

        // Controles do player
        dom.ctrlPlayBtn.addEventListener('click', () => {
          if (!state.currentChannel) return;
          if (dom.video.paused) dom.video.play().catch(() => {});
          else dom.video.pause();
        });
        dom.ctrlReloadBtn.addEventListener('click', () => { if (state.currentChannel) playChannel(state.currentChannel); });
        dom.errorReloadBtn.addEventListener('click', () => { if (state.currentChannel) playChannel(state.currentChannel); });
        dom.ctrlMuteBtn.addEventListener('click', () => { dom.video.muted = !dom.video.muted; });
        dom.ctrlVolumeSlider.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          dom.video.volume = val;
          dom.video.muted = val === 0;
        });
        dom.ctrlFavBtn.addEventListener('click', () => {
          if (state.currentChannel) toggleFavorite(state.currentChannel);
          else showToast('Selecione um canal primeiro.', 'info');
        });
        dom.ctrlCopyBtn.addEventListener('click', () => {
          if (state.currentChannel) copyToClipboard(state.currentChannel.url, `Link M3U8 de "${state.currentChannel.name}" copiado!`);
          else showToast('Selecione um canal primeiro.', 'info');
        });
        dom.ctrlExternalBtn.addEventListener('click', () => {
          if (state.currentChannel) window.open(state.currentChannel.url, '_blank', 'noopener,noreferrer');
          else showToast('Selecione um canal primeiro.', 'info');
        });
        dom.ctrlPipBtn.addEventListener('click', async () => {
          try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else if (document.pictureInPictureEnabled && dom.video.readyState >= 2) await dom.video.requestPictureInPicture();
            else showToast('Picture-in-Picture indisponível neste momento.', 'warning');
          } catch {
            showToast('Não foi possível ativar o Picture-in-Picture.', 'warning');
          }
        });
        dom.ctrlFullscreenBtn.addEventListener('click', () => {
          const target = dom.playerWrapper;
          if (!document.fullscreenElement) {
            if (target.requestFullscreen) target.requestFullscreen().catch(() => {});
            else if (dom.video.webkitEnterFullscreen) dom.video.webkitEnterFullscreen();
          } else if (document.exitFullscreen) {
            document.exitFullscreen();
          }
        });

        // Overlay de diagnóstico
        dom.errorTryHttpsBtn.addEventListener('click', () => {
          if (!state.currentChannel) return;
          const httpsUrl = state.currentChannel.url.replace(/^http:\/\//i, 'https://');
          dom.playerErrorOverlay.classList.add('hidden');
          dom.playerLoadingOverlay.classList.remove('hidden');
          dom.playerLoadingText.textContent = 'Promovendo conexão para HTTPS e reconectando stream...';
          setStreamStatus('buffering');
          state.hlsRetryCount = 0;
          showToast('Tentando reprodução segura via HTTPS...', 'info');
          void startDirectPlayback(httpsUrl, false);
        });
        dom.errorCopyBtn.addEventListener('click', () => {
          if (state.currentChannel) copyToClipboard(state.currentChannel.url, 'URL copiada! Cole no VLC ou TiviMate.');
        });

        // Central DNS
        dom.openDnsModalBtn.addEventListener('click', openDnsModal);
        dom.telemetryDetailsBtn.addEventListener('click', openDnsModal);
        dom.closeDnsModalBtn.addEventListener('click', closeDnsModal);
        dom.dnsModal.addEventListener('click', (e) => { if (e.target === dom.dnsModal) closeDnsModal(); });
        dom.modalRetestDohBtn.addEventListener('click', retestAllDohProviders);

        dom.modalDohList.addEventListener('click', (e) => {
          const removeBtn = e.target.closest('button[data-remove-doh]');
          if (removeBtn) {
            const id = removeBtn.dataset.removeDoh;
            state.dohProviders = state.dohProviders.filter(p => p.id !== id);
            if (state.activeDohId === id) {
              state.activeDohId = (getHealthyDohSorted()[0] || state.dohProviders[0]).id;
            }
            saveCustomDohProviders();
            renderDohViews();
            showToast('Servidor DoH customizado removido.', 'info');
            return;
          }
          const selectBtn = e.target.closest('button[data-select-doh]');
          if (selectBtn) {
            state.activeDohId = selectBtn.dataset.selectDoh;
            renderDohViews();
            showToast(`API de diagnóstico DoH: ${getActiveDohProvider().name} (não altera DNS do navegador)`, 'success');
          }
        });

        dom.clearDnsCacheBtn.addEventListener('click', () => {
          state.dnsCache.clear();
          state.cacheHits = 0;
          state.cacheMisses = 0;
          updateCacheStatsUi();
          showToast('Cache DNS limpo com sucesso.', 'success');
        });

        dom.manualLookupForm.addEventListener('submit', (e) => {
          e.preventDefault();
          runManualLookup(dom.lookupDomainInput.value, dom.lookupTypeSelect.value);
        });

        dom.addCustomDohBtn.addEventListener('click', async () => {
          const name = dom.customDohName.value.trim() || 'DoH Customizado';
          const template = dom.customDohUrl.value.trim();
          if (!template || !/^https:\/\//i.test(template)) {
            showToast('Informe uma URL HTTPS válida para o servidor DoH.', 'warning');
            return;
          }
          const newProvider = {
            id: `custom_doh_${Date.now()}`, name, subtitle: 'Servidor DoH Personalizado', template,
            acceptDnsJson: dom.customDohAccept.checked, custom: true,
            status: 'testing', latency: null, resolvedIp: null, dnssec: false,
          };
          state.dohProviders.push(newProvider);
          saveCustomDohProviders();
          dom.customDohName.value = '';
          dom.customDohUrl.value = '';
          renderDohViews();

          const res = await benchmarkDohProvider(newProvider);
          if (res.ok) {
            state.activeDohId = newProvider.id;
            renderDohViews();
            showToast(`"${newProvider.name}" online (${res.latency} ms) e ativado!`, 'success');
          } else {
            showToast(`"${newProvider.name}" adicionado, mas não respondeu ao teste DoH JSON.`, 'warning');
          }
        });

        // Importação
        dom.openImportModalBtn.addEventListener('click', openImportModal);
        dom.closeImportModalBtn.addEventListener('click', closeImportModal);
        dom.importModal.addEventListener('click', (e) => { if (e.target === dom.importModal) closeImportModal(); });

        dom.importUrlSubmitBtn.addEventListener('click', () => {
          const url = dom.importUrlInput.value.trim();
          if (!url || !/^https?:\/\//i.test(url)) {
            showToast('Digite uma URL .m3u ou .m3u8 válida.', 'warning');
            return;
          }
          closeImportModal();
          state.activeTab = 'all';
          updateTabButtons();
          loadExternalUrlPlaylist(url);
          dom.importUrlInput.value = '';
        });

        dom.importFileInput.addEventListener('change', (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            closeImportModal();
            state.activeTab = 'all';
            updateTabButtons();
            loadLocalPlaylistText(file.name.replace(/\.(m3u8|m3u)$/i, ''), String(reader.result || ''));
            dom.importFileInput.value = '';
          };
          reader.onerror = () => showToast('Erro ao ler o arquivo local.', 'error');
          reader.readAsText(file);
        });

        // ESC: fecha modais e recolhe a Dynamic Island (listener único)
        document.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          closeDnsModal();
          closeImportModal();
          if (dom.ghDynamicIsland) dom.ghDynamicIsland.classList.remove('is-expanded');
        });

        // Dynamic Island: toque em dispositivos sem hover
        if (dom.ghDynamicIsland) {
          dom.ghDynamicIsland.addEventListener('click', (e) => {
            const isTouch = window.matchMedia('(hover: none)').matches;
            if (isTouch && !dom.ghDynamicIsland.classList.contains('is-expanded')) {
              e.preventDefault();
              dom.ghDynamicIsland.classList.add('is-expanded');
            }
          });
          document.addEventListener('click', (e) => {
            if (dom.ghDynamicIsland.classList.contains('is-expanded') && !dom.ghDynamicIsland.contains(e.target)) {
              dom.ghDynamicIsland.classList.remove('is-expanded');
            }
          });
        }
      }


      /* =====================================================================
         CAST + MULTIFONTES (100% navegador; nenhuma API supera CORS ou DRM)
         ===================================================================== */
      async function fetchPlaylistSource(source) {
        if (source.file) return fetchOfficialPlaylistWithCdnFailover(source.file);
        const urls = [source.url, ...(source.mirrors || [])]
          .filter(url => /^https?:\/\//i.test(url || ''));
        return fetchPlaylistWithFailover(
          urls.map(url => ({ url, mirror: { label: new URL(url).hostname } })),
          15000,
        );
      }

      async function loadUnifiedPlaylist(playlist) {
        stopBatchAuditIfRunning();
        const seq = ++state.playlistLoadSeq;
        state.currentPlaylist = playlist;
        state.activeTab = 'all';
        updateTabButtons();
        dom.currentPlaylistName.textContent = playlist.name;
        dom.cdnOriginStatus.textContent = 'Unificando fontes de IPTV diretamente no navegador...';
        renderPlaylistPills();
        resetCatalogUi();
        const sources = playlist.combine.map(id => OFFICIAL_PLAYLISTS.find(x => x.id === id)).filter(Boolean);
        const queue = sources.slice();
        const channels = [], seen = new Set(), successes = [], failed = [];
        let completed = 0;
        dom.channelCounter.textContent = 'Unificando 0/' + sources.length + ' fontes...';
        async function worker() {
          while (queue.length && seq === state.playlistLoadSeq) {
            const src = queue.shift();
            if (!src) break;
            try {
              const response = await fetchPlaylistSource(src);
              if (seq !== state.playlistLoadSeq) return;
              const parsed = parseM3U8(response.text);
              for (const ch of parsed) {
                if (channels.length >= 30000) break;
                if (seen.has(ch.url)) continue;
                seen.add(ch.url);
                ch.source = src.name;
                channels.push(ch);
              }
              if (parsed.length) successes.push(src.name); else failed.push(src.name);
            } catch (error) {
              failed.push(src.name);
              console.warn('Playlist sem acesso:', src.name, error.message);
            } finally {
              completed++;
              if (seq === state.playlistLoadSeq) {
                // Exibe os primeiros resultados enquanto outras fontes ainda carregam.
                if (channels.length && (completed === 1 || completed % 2 === 0)) {
                  state.allChannels = channels.slice();
                  dom.listLoadingState.classList.add('hidden');
                  buildCategoryChips();
                  applyFiltersAndRender();
                }
                dom.channelCounter.textContent = 'Unificando ' + completed + '/' + sources.length + ' • ' + channels.length.toLocaleString('pt-BR') + ' streams';
              }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(sources.length, 3) }, worker));
        if (seq !== state.playlistLoadSeq) return;
        // Inclui listas próprias importadas nesta sessão, sem publicar URLs privadas no GitHub.
        for (const custom of state.extraCatalogs) {
          for (const ch of custom.channels) {
            if (channels.length >= 30000) break;
            if (seen.has(ch.url)) continue;
            seen.add(ch.url);
            channels.push({ ...ch, source: custom.name });
          }
        }
        state.allChannels = channels;
        dom.listLoadingState.classList.add('hidden');
        dom.cdnOriginStatus.textContent = successes.length + '/' + sources.length + ' fontes • ' + channels.length.toLocaleString('pt-BR') + ' URLs únicas';
        buildCategoryChips();
        applyFiltersAndRender();
        if (!channels.length) {
          dom.listEmptyState.classList.remove('hidden');
          dom.emptyStateTitle.textContent = 'Nenhuma fonte disponível';
          dom.emptyStateDesc.textContent = 'Experimente uma fonte individual ou importe um M3U; o navegador depende de CORS.';
          dom.retryPlaylistBtn.classList.remove('hidden');
        } else if (failed.length) {
          showToast('Catálogo parcial: ' + successes.length + '/' + sources.length + ' fontes disponíveis.', 'warning');
        } else {
          showToast(channels.length.toLocaleString('pt-BR') + ' streams únicos reunidos.', 'success');
        }
      }

      function wvcDeepLink(channel) {
        return buildWebVideoCasterUrl(channel);
      }

      function openInWebVideoCaster(channel) {
        const link = wvcDeepLink(channel);
        if (!link) return showToast('A URL precisa ser HTTP ou HTTPS.', 'warning');
        showToast('Abrindo Web Video Caster. Se não abrir, use Compartilhar canal ou copie o link.', 'info');
        // Chamada em gesto do usuário: o SO confirma a abertura do aplicativo.
        window.location.href = link;
      }

      function exportCatalogM3U() {
        if (!state.allChannels.length) return showToast('Carregue uma lista antes de exportar.', 'warning');
        const blob = new Blob([serializeM3U(state.allChannels)], {
          type: 'application/vnd.apple.mpegurl;charset=utf-8',
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'zplayer-' + String(state.currentPlaylist?.id || 'lista').replace(/[^a-z0-9-]/gi, '') + '.m3u';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast('M3U baixado. Importe no Web Video Caster.', 'success');
      }

      async function shareChannel() {
        if (!state.currentChannel) return showToast('Escolha um canal primeiro.', 'info');
        const ch = state.currentChannel;
        if (navigator.share) {
          try { await navigator.share({ title: ch.name, url: ch.url }); return; }
          catch (error) { if (error.name === 'AbortError') return; }
        }
        copyToClipboard(ch.url, 'Link copiado para compartilhar.');
      }

      function initWebVideoCasterUi() {
        const button = document.createElement('button');
        button.id = 'ctrl-wvc-btn';
        button.type = 'button';
        button.textContent = '📺 WVC';
        button.title = 'Abrir canal no Web Video Caster';
        button.className = 'm3-btn h-9 px-2.5 rounded-xl text-[11px] font-bold bg-gradient-to-r from-cyan-600 to-indigo-600 text-white';
        dom.ctrlExternalBtn.before(button);
        button.addEventListener('click', () => {
          if (state.currentChannel) openInWebVideoCaster(state.currentChannel);
          else showToast('Selecione um canal primeiro.', 'info');
        });
        const errorButton = document.createElement('button');
        errorButton.id = 'error-wvc-btn';
        errorButton.type = 'button';
        errorButton.textContent = '📺 Abrir no WVC';
        errorButton.className = 'm3-btn px-4 py-2 rounded-full text-xs font-semibold bg-gradient-to-r from-cyan-600 to-indigo-600 text-white';
        dom.errorCopyBtn.before(errorButton);
        errorButton.addEventListener('click', () => {
          if (state.currentChannel) openInWebVideoCaster(state.currentChannel);
        });
        const panel = document.createElement('div');
        panel.id = 'wvc-action-panel';
        panel.className = 'mt-3 px-2 flex flex-col sm:flex-row items-start sm:items-center gap-2 justify-between text-xs';
        panel.innerHTML = '<p class="text-sec text-[11px] flex-1">📺 <strong>Web Video Caster:</strong> abra esta página no navegador do app ou toque em WVC no canal. A TV precisa suportar o codec e a origem.</p>' +
          '<div class="flex gap-2 flex-wrap"><button id="wvc-share-btn" type="button" class="m3-pill rounded-full px-3 py-2 font-semibold">Compartilhar canal</button>' +
          '<button id="wvc-export-btn" type="button" class="m3-pill rounded-full px-3 py-2 font-semibold">Exportar M3U</button></div>';
        dom.playerWrapper.parentElement.appendChild(panel);
        document.getElementById('wvc-share-btn').addEventListener('click', shareChannel);
        document.getElementById('wvc-export-btn').addEventListener('click', exportCatalogM3U);
        window.zPlayerTools = Object.freeze({
          buildCastUrl: wvcDeepLink,
          sourceIds: () => OFFICIAL_PLAYLISTS.map(x => x.id),
          loadedChannelCount: () => state.allChannels.length,
        });
      }

      /* ======================================================================
         BOOTSTRAP
         ====================================================================== */
      function bootstrap() {
        applyThemeAndSurface();
        initDohPool();
        renderPlaylistPills();
        updateFavBadge();
        updateTabButtons();
        updateCacheStatsUi();
        bindVideoEvents();
        bindUiEvents();
        initWebVideoCasterUi();
        // A interface e o catálogo não dependem da disponibilidade de DoH.
        enterMainApp();
        void runBootDnsHandshake().catch(err => console.info("Benchmark DoH:", err));
      }

      if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', bootstrap);
      } else {
        bootstrap();
      }
    })();
