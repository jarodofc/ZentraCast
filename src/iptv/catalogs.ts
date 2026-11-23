import type { Mirror, PlaylistSource } from '../types';

/** Playlists públicas e listas unificadas. Não hospedamos os streams. */
export const OFFICIAL_PLAYLISTS: PlaylistSource[] = [
  { id: 'canais', name: 'Canais IPTV', file: 'CanaisIPTV.m3u8' },
  { id: 'unificado', name: '📡 Tudo em um', combine: ['canais','ramys-geral','ramys-br01','ramys-br02','ramys-br03','ramys-br04','filmes-series','iptvorg-br','free-tv'] },
  { id: 'filmes-series', name: 'Filmes e Séries', file: 'Filmes-Series.m3u8' },
  { id: 'ramys-geral', name: 'Ramys Geral', file: 'Canais.m3u8' },
  { id: 'ramys-br01', name: 'Brasil 01', file: 'CanaisBR01.m3u8' },
  { id: 'ramys-br02', name: 'Brasil 02', file: 'CanaisBR02.m3u8' },
  { id: 'ramys-br03', name: 'Brasil 03', file: 'CanaisBR03.m3u8' },
  { id: 'ramys-br04', name: 'Brasil 04', file: 'CanaisBR04.m3u8' },
  { id: 'iptvorg-br', name: 'IPTV-org Brasil', url: 'https://iptv-org.github.io/iptv/countries/br.m3u', mirrors: ['https://raw.githubusercontent.com/iptv-org/iptv/master/streams/br.m3u'] },
  { id: 'free-tv', name: 'Free-TV Global', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', mirrors: ['https://cdn.jsdelivr.net/gh/Free-TV/IPTV@master/playlist.m3u8'] },
];

export const CDN_MIRRORS: Mirror[] = [
  { id: 'github-master', label: 'GitHub Raw (master)', host: 'raw.githubusercontent.com', buildUrl: file => 'https://raw.githubusercontent.com/Ramys/Iptv-Brasil-2026/master/' + encodeURIComponent(file) },
  { id: 'jsdelivr-master', label: 'jsDelivr CDN (@master)', host: 'cdn.jsdelivr.net', buildUrl: file => 'https://cdn.jsdelivr.net/gh/Ramys/Iptv-Brasil-2026@master/' + encodeURIComponent(file) },
  { id: 'github-main', label: 'GitHub Raw (main)', host: 'raw.githubusercontent.com', buildUrl: file => 'https://raw.githubusercontent.com/Ramys/Iptv-Brasil-2026/main/' + encodeURIComponent(file) },
];
