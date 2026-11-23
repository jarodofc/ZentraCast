/** Contratos dos canais, listas e serviços usados pelos módulos tipados. */
export interface StreamHeaders {
  Referer?: string;
  'User-Agent'?: string;
}
export interface Channel {
  id: string;
  name: string;
  tvgName: string;
  logo: string;
  group: string;
  subtitle: string;
  headers: StreamHeaders;
  url: string;
  host: string;
  searchKey: string;
  source?: string;
}
export interface PlaylistSource {
  id: string;
  name: string;
  file?: string;
  url?: string;
  mirrors?: string[];
  combine?: string[];
}
export interface Mirror { id: string; label: string; host: string; buildUrl(file: string): string }
export interface PlaylistResult { text: string; mirror: Pick<Mirror, 'label'>; url: string }
