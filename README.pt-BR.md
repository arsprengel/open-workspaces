<p align="center">
  <img src="docs/icon-512.png" width="96" height="96" alt="Logo do Open Workspaces" />
</p>

<h1 align="center">Open Workspaces</h1>

<p align="center">
  <strong>Workspaces de abas grátis e open-source.</strong><br />
  Workspaces ilimitados, recursos, notas, tarefas e suspensão de abas. Sem conta, sem paywall, sem rastreamento.
</p>

<p align="center"><a href="README.md">English</a></p>

<p align="center">
  <img src="docs/screenshots/home.png" alt="Aba inicial: o workspace desta janela" width="49%" />
  <img src="docs/screenshots/sidepanel-dark.png" alt="Painel lateral" width="24%" />
</p>

## Por quê?

Gerenciadores como o Workona são ótimos até você passar dez minutos organizando suas abas e esbarrar no limite de workspaces do plano grátis. O Open Workspaces faz o mesmo trabalho principal **sem limites**, guarda **tudo no seu próprio navegador** e é **licença MIT**: qualquer um pode auditar, fazer fork ou melhorar.

## Funcionalidades

- **Workspaces ilimitados**, com nome, cor (pronta ou personalizada) e ícone: emoji, inicial ou uma imagem sua (PNG, ICO, SVG, JPG, WebP).
- **Aba inicial.** Uma aba fixa pequena com o ícone da extensão fica à esquerda de cada janela. Clique nela para ver o workspace desta janela e trocar para qualquer outro com um clique; depois da troca a janela fica nesta página, com a última aba usada do workspace já carregada por trás.
- **Abas fixadas ficam no lugar.** Abas que você fixa no navegador (Gmail, YouTube...) pertencem à janela e continuam abertas em todos os workspaces. Ao abrir um site que fica sempre aberto (Gmail, Outlook, WhatsApp, Slack, Teams, Discord, Spotify...) numa aba não fixada, a janelinha da extensão pergunta se você quer fixá-lo.
- **Troca na mesma janela** (ou em janela nova, você escolhe). Tudo é salvo automaticamente.
- **Você não perde abas:** janelas com abas não salvas nunca são substituídas, fechar um workspace mantém as abas salvas, e janelas reabertas (Ctrl+Shift+T ou depois de reiniciar o navegador) são religadas ao workspace sozinhas.
- **Grupos de abas** são preservados.
- **Recursos:** links importantes em seções, com arrastar e soltar.
- **Notas e tarefas** em cada workspace.
- **Troca rápida** (Alt+A) com busca em workspaces, abas salvas e recursos.
- **Painel lateral** (Alt+S) e **mover aba** para outro workspace (Alt+T).
- **Dar uma olhada em outro workspace sai de graça.** Quando você troca, as abas do workspace que ficou para trás esperam, ainda carregadas, numa bolinha com a cor dele no fim da barra de abas (15 minutos por padrão, ajustável ou desligável). Se você voltar nesse tempo, elas reaparecem no lugar, sem recarregar; sem uso por esse tempo, elas fecham (uma aba tocando som espera o som acabar).
- **Abas que continuam rodando.** Marque uma aba com o botão de raio (ou clique com o botão direito na página) e ela continua funcionando enquanto você está em outro workspace: fica nessa mesma bolinha no fim da barra de abas e volta para o lugar, sem recarregar.
- **Suspensão de abas** nativa: abas restauradas carregam sob demanda e há suspensão automática opcional (máximo de N abas na memória ou após X minutos sem uso), com exceções.
- **Arquivar, duplicar, reordenar**, **backup** em JSON, **tema claro/escuro**, inglês e português.

## Instalação

1. Baixe o `.zip` da [última release](../../releases) e descompacte, ou clone o repositório.
2. Abra `chrome://extensions` (ou `edge://extensions`, `brave://extensions`…).
3. Ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e escolha a pasta `extension/`.
5. Fixe a extensão na barra e aperte **Alt+A**.

Funciona em qualquer navegador Chromium 116+: Chrome, Edge, Brave, Vivaldi, Opera, Helium, Arc etc.

## Desenvolvimento

Sem etapa de build. Veja a seção [Development](README.md#development) do README em inglês e o [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test && npm run check && npm run smoke
```

## Licença

[MIT](LICENSE). Sem relação com o Workona.
