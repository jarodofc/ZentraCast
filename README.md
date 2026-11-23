# zPLAYER — IPTV Hub + Web Video Caster

Player IPTV estático, com múltiplas fontes M3U, diagnóstico DoH e integração com **Web Video Caster**. A aplicação roda **inteiramente no navegador**, com HTML5, CSS3/Tailwind, TypeScript, HLS.js e Vite. Não exige backend, proxy próprio ou token para carregar as fontes públicas configuradas.

## Abrir e transmitir

1. Acesse [zPLAYER](https://zplayer-alpha.vercel.app/) no navegador do celular ou no navegador integrado do Web Video Caster.
2. Selecione **📡 Tudo em um**, uma lista individual ou importe uma URL/arquivo M3U.
3. Escolha um canal. Use **📺 WVC** para abrir o stream no Web Video Caster ou **Compartilhar canal** para enviar a URL por outros aplicativos.
4. Use **Exportar M3U** para salvar o catálogo no seu dispositivo e importá-lo em um player compatível.

O protocolo `wvc-x-callback://open` é suportado pelo aplicativo móvel, mas depende de o sistema operacional permitir o redirecionamento e de o app estar instalado. Consulte a [documentação oficial](https://www.webvideocaster.com/integrations).

## Arquitetura

| Arquivo/módulo | Linguagem | Responsabilidade |
|---|---|---|
| `index.html` | HTML5 | Interface e elementos do player |
| `src/styles/app.css` | CSS3 + Tailwind | Liquid Glass, temas e responsividade; compilado no build |
| `src/main.ts` | TypeScript | Entrada do aplicativo e importação de estilos |
| `src/app.ts` | TypeScript (controlador legado em migração) | Estado da UI, eventos, favoritos, DoH, telemetria e fluxo de reprodução |
| `src/types.ts` | TypeScript estrito | Tipos dos canais, listas e cabeçalhos |
| `src/iptv/m3u.ts` | TypeScript estrito | Parser e exportador M3U |
| `src/iptv/catalogs.ts` | TypeScript estrito | Fontes IPTV e espelhos CDN |
| `src/network/playlist.ts` | TypeScript estrito | Fetch com timeout/limites, failover e cache de listas |
| `src/player/hls-loader.ts` | TypeScript estrito | HLS.js carregado sob demanda, com fallback em CDN |
| `src/cast/web-video-caster.ts` | TypeScript estrito | Deep links para abrir streams no WVC |
| `vite.config.ts` e `vercel.json` | Configuração | Compilação e publicação estática na Vercel |

O controlador `src/app.ts` mantém temporariamente `// @ts-nocheck` para preservar o funcionamento da interface legada. Os **novos módulos têm verificação de tipos estrita**; o controlador será tipado gradualmente. Não confunda essa migração com uma reescrita total da aplicação.

## Desenvolver e publicar

**Requisitos:** Node.js 22.12+ e npm.

```bash
npm install
npm run dev         # servidor local (Vite)
npm run typecheck   # verifica os módulos tipados
npm run build       # gera a pasta dist/
npm run preview     # visualiza o build local
```

A Vercel usa `npm run build` e publica o conteúdo estático de `dist/`. **Nenhuma aplicação Node.js fica rodando em produção.** Não abra `index.html` com `file://` para desenvolvimento; use o servidor Vite ou a URL de produção.

## Fontes IPTV

- **Ramys / IPTV Brasil 2026:** `CanaisIPTV.m3u8`, `Canais.m3u8`, `CanaisBR01.m3u8`–`CanaisBR04.m3u8`, `Filmes-Series.m3u8`.
- **iptv-org Brasil:** `https://iptv-org.github.io/iptv/countries/br.m3u`.
- **Free-TV Global:** `https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8`.
- **Listas próprias:** carregamento via URL HTTP(S) ou arquivos M3U locais.

O catálogo combinado abre até três fontes em paralelo, mostra resultados progressivamente, deduplica URLs, preserva importações próprias nesta sessão e limita o agregado a 30 mil streams únicos em memória. Nenhum servidor/stream de terceiro é copiado para este repositório.

## Requisitos e limites das conexões

- DNS-over-HTTPS fornece diagnósticos públicos, **não troca o resolvedor do navegador**.
- CORS, DRM, autenticação por cabeçalho/tokens, bloqueios geográficos, expiração de links, codecs e limitações de reprodução dependem do servidor e do receptor.
- O player não contorna CORS; mídia HTTP em páginas HTTPS pode ser bloqueada por conteúdo misto.
- Cache Storage pode guardar playlists já abertas, quando o navegador permite; streams remotos não passam a funcionar offline por isso.
- O Web Video Caster recebe URL e metadados de cast, não o vídeo transmitido pelo servidor deste projeto.
- Use listas e conteúdo aos quais tenha permissão de acesso.

## Verificações

O build roda o TypeScript antes da compilação com Vite (`npm run build`). Conferir o status do deploy Vercel após as mudanças. Também é recomendável validar importação local, reprodução HLS, transferência WVC em Android/iOS e codec/áudio na TV real, que não são reproduzíveis apenas por testes de build.
