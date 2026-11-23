# zPLAYER — IPTV Hub + Web Video Caster

Interface IPTV estática em português, com catálogo multifontes, HLS.js e integração com **Web Video Caster**. Implementação em HTML/CSS/JavaScript executada no navegador: **sem backend, proxy ou credenciais de API**.

## Início rápido

1. Abra o [zPLAYER](https://zplayer-alpha.vercel.app/) no navegador ou dentro do navegador integrado do app Web Video Caster.
2. Selecione **📡 Tudo em um** para unir as listas; ou abra uma fonte individual para carregar mais rápido.
3. Clique no canal e, no celular, toque em **📺 WVC** para encaminhar ao aplicativo (Android/iOS).
4. Use **Exportar M3U** para salvar a playlist atual no dispositivo ou **Compartilhar canal** para enviar um link pelo menu de compartilhamento do celular.

O botão WVC usa o protocolo documentado `wvc-x-callback://open?url=...`, com título, capa, tipo MIME e, quando presente no M3U, Referer e User-Agent. Consulte a [integração oficial](https://www.webvideocaster.com/integrations). A abertura do app depende de ele estar instalado e de o navegador/SO aceitar o esquema.

## Catálogos

| Fonte | Arquivo ou endpoint |
|---|---|
| Ramys / IPTV Brasil 2026 | `CanaisIPTV.m3u8`, `Canais.m3u8`, `CanaisBR01.m3u8` a `CanaisBR04.m3u8`, `Filmes-Series.m3u8` |
| iptv-org Brasil | `https://iptv-org.github.io/iptv/countries/br.m3u` |
| Free-TV Global | `https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8` |
| Listas próprias | URL de playlist ou arquivo local `.m3u/.m3u8` |

A opção **Tudo em um** carrega até três fontes ao mesmo tempo, exibe resultados progressivamente, remove URLs duplicadas e aceita falhas parciais. Listas importadas manualmente também entram no catálogo combinado durante a sessão. São mantidos até 30 mil streams únicos em memória por catálogo unificado para limitar o consumo. O código não modifica nem redistribui os arquivos das listas públicas.

## Conexão e compatibilidade

- **No navegador:** HTML5 `<video>` e HLS.js, quando necessário, com tentativa de reconexão e CDN alternativa para a biblioteca e os catálogos.
- **No Web Video Caster:** encaminhamento direto dos endereços e metadados compatíveis via esquema oficial, sem transmissão de vídeo pelo servidor do zPLAYER.
- **DNS-over-HTTPS:** consulta servidores públicos para diagnóstico e latência. **Não troca o DNS do navegador**.
- **Cache:** quando permitido, Cache Storage conserva playlists já abertas neste dispositivo.
- **Offline:** só há fallback para **listas previamente armazenadas em cache**; a reprodução de streams remotos requer conexão.

### Restrições inevitáveis

- O navegador **não consegue contornar CORS** de um servidor remoto. O arquivo local pode ser importado, mas a reprodução HLS também pode depender de CORS.
- **DRM**, expiração de tokens, geobloqueio, servidores fora do ar, protocolos/áudio/vídeo não suportados e autenticação específica podem impedir a reprodução ou o cast.
- A Smart TV/receptor tem de conseguir acessar a URL e decodificar seu stream. O Web Video Caster não garante compatibilidade universal.
- Streams em HTTP em uma página HTTPS podem ser bloqueados como conteúdo misto; forçar HTTPS só funciona quando o servidor de origem o suporta.
- Use apenas listas e transmissões para as quais tenha autorização.

## Testes realizados no código

- Sintaxe JavaScript e IDs duplicados do HTML.
- Parser M3U: agrupamento, deduplicação e leitura de `#EXTVLCOPT:http-referrer` / `http-user-agent`.
- Construção de URLs de integração WVC.
- Agregação de URLs únicas com fonte offline simulada e lista importada na sessão.

**Pendência de validação:** a abertura real do app Web Video Caster e a reprodução de cada servidor IPTV precisam de teste em Android/iOS e na TV escolhida; esses dispositivos não foram acessados remotamente.

## Desenvolver

Sirva a raiz do repositório por HTTPS ou servidor HTTP local. A página é `index.html` e não exige processo de build. O Tailwind carregado em tempo de execução e o HLS.js (sob demanda) necessitam dos CDNs correspondentes acessíveis.

