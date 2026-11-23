# ZentraCast — Guia visual minimalista

**Nome público:** ZentraCast  
**Assinatura:** IPTV simplificado · Web Video Caster  
**Princípio:** conteúdo em primeiro plano, interface em segundo.

## Marca e arquivos

O ícone é um monograma geométrico **Z** com um pequeno sinal de transmissão. A versão é inteiramente vetorial, sem efeitos 3D, sem imagem raster nem fonte embutida.

- `public/brand/mark.svg` — símbolo transparente, para aplicações sobre fundo escuro.
- `public/favicon.svg` — ícone quadrado com cantos arredondados para abas e instalação.
- `public/manifest.webmanifest` — nome, ícone e aparência do aplicativo.
- `index.html` — marca textual e ícone no cabeçalho e na tela inicial.

Para gerar outras versões do símbolo, preserve o traço contínuo em Z, a cor clara e **um** detalhe azul no sinal de transmissão. Mantenha espaço livre ao redor do ícone.

## Paleta

| Token | Escuro | Claro | Uso |
|---|---|---|---|
| Background | `#0B111B` | `#F5F7FA` | Plano de fundo |
| Text | `#F5F7FB` | `#152131` | Texto principal |
| Accent | `#83AEFF` | `#355FCE` | Navegação, links e foco |
| Secondary accent | `#80D7D0` | `#087A75` | Sinais de estado quando apropriado |
| Logo panel | `#121C2A` | `#121C2A` | Base invariável do símbolo |

As superfícies usam transparência sutil, borda de 1px e blur moderado, sempre com modo sólido e preferências de transparência reduzida. Não aplicar gradientes multicoloridos em botões principais.

## Tipografia

**Manrope** em títulos, navegação e corpo: pesos 400–800, espaçamento levemente negativo e tamanhos responsivos. **IBM Plex Mono** apenas para DNS, latência, URLs e números técnicos. Web fonts carregadas com `display=swap`, mantendo fallbacks do sistema.

## Ícones e componentes

- Ícones vetoriais SVG, `viewBox="0 0 24 24"`, traço 1.8–2, cantos e pontas arredondados.
- Área de toque preferencial de pelo menos 40–44px em ações frequentes.
- Botões de ação em azul sólido; controles secundários neutros.
- Cards com bordas discretas e destaque apenas no item selecionado ou em reprodução.
- Foco de teclado visível com contorno de 2px na cor de ação.
- Respeitar `prefers-reduced-motion` e `prefers-reduced-transparency`.

## Arquitetura

Os estilos de marca estão no final de `src/styles/app.css`, sobre os componentes existentes. Tokens `--accent`, `--action-bg`, `--glass-bg`, `--glass-border` e `--bg-base` mantêm consistência entre tema escuro, claro e modo sólido.

O sistema visual não altera URLs de IPTV, parseamento M3U, DNS-over-HTTPS, HLS.js, favoritos ou integração com Web Video Caster. A UI continua inteiramente client-side, gerada por Vite e TypeScript.
