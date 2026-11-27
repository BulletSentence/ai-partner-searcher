# DataWatch

Copiloto de reuniões local: transcreve a conversa em tempo real e sugere respostas com base nas suas notas e projetos.

## Recursos

- Transcrição local em tempo real com Whisper.cpp, em português brasileiro ou inglês, cortada nas pausas da fala e com o vocabulário da reunião informado ao modelo.
- Gravação do áudio e da transcrição de cada reunião em uma pasta própria dentro de `meetings/`.
- No macOS, captura simultânea do áudio do sistema (cliente) e do microfone (você), com a identificação de quem falou.
- Resposta automática apenas para perguntas do cliente; a sua fala é transcrita e gravada, mas não dispara respostas.
- Captura de áudio do sistema ou microfone em Linux com PulseAudio/PipeWire.
- Janela transparente, sem moldura e sempre no topo para acompanhar a reunião, com tema escuro ou claro e opacidade do fundo ajustável.
- Modo privacidade, ligado sempre que o app abre: a janela não aparece em prints nem no compartilhamento de tela.
- Campo de contexto da reunião, caminhos de projetos e caminho do vault Obsidian.
- Índice local rápido para Markdown, texto, JSON, YAML e arquivos de código, com o vault indexado primeiro e uma cota própria para cada pasta.
- Busca de trechos relevantes: somente os trechos selecionados acompanham a pergunta enviada à IA.
- Fallback local para o vault configurado quando uma integração MCP não estiver disponível.
- OCR de tela com `Ctrl+Shift+S` para incluir conteúdo visível no contexto.
- Histórico inclui provedor, fontes consultadas e métricas de latência por resposta.
- Histórico de reuniões com exportação para o Harness (a reunião enviada fica marcada) e exclusão com confirmação, pela Lixeira.
- Chaves de API da OpenAI, Claude (Anthropic) e Gemini configuradas na própria tela, guardadas criptografadas; o provedor é reconhecido pela chave e os modelos disponíveis são listados.
- Escolha do modelo do agente na tela inicial, com os outros provedores configurados e o Ollama local como alternativa automática.
- Glossário da transcrição editável na tela e vocabulário de nomes próprios aprendido das notas indexadas.

## Instalação

```bash
nvm use
npm install
cp .env.example .env
```

As chaves de API não ficam no `.env`: elas são cadastradas no app (veja [Provedores de IA](#provedores-de-ia)). O `.env` guarda só valores padrão opcionais do formulário e caminhos:

```env
MEETING_CONTEXT=
PROJECT_PATHS=/caminho/para/projeto-1
OBSIDIAN_VAULT_PATH=/caminho/para/ObsVaultCredifit
MEETING_LANGUAGE=pt-BR
```

`PROJECT_PATHS` aceita um caminho por linha. O índice ignora pastas ocultas (`.git`, `.obsidian`, `.claude`), `node_modules` e builds.

Para gravar as reuniões em outro lugar (por exemplo, dentro do vault), defina `MEETINGS_DIR=/caminho/para/pasta`.

### Whisper.cpp: binário e modelos de voz

O app usa o Whisper.cpp localmente. Baixe o código-fonte do motor e compile o adaptador de streaming uma vez. São necessários `git`, CMake e um compilador C++ (no Linux: `build-essential`; no macOS: `xcode-select --install`).

```bash
npm run whisper:build
```

O comando baixa o Whisper.cpp em `.cache/`, ativa Metal automaticamente no macOS e gera um adaptador estático em `bin/whisper-stream`.

Baixe então ao menos um modelo Whisper para `models/`. Para português brasileiro, `large-v3-turbo` é o recomendado; `small` é uma alternativa mais leve:

```bash
npm run whisper:model
npm run whisper:model -- small
```

Reinicie o app e selecione o arquivo no campo **Modelo de transcrição**. Para manter modelos fora do projeto, defina `WHISPER_MODELS_DIR=/caminho/para/modelos`; para apontar para outro adaptador, use `WHISPER_CPP_BIN=/caminho/para/whisper-stream`.

Registre termos próprios, siglas e variações de transcrição no campo **Glossário da transcrição** da tela de configuração, um por linha, no formato `Nome certo: variação 1, variação 2`. O texto fica salvo junto com as outras configurações do app, então também pode ser editado no app instalado. Na primeira execução o campo vem preenchido com `meeting-grammar.json`, que serve só como ponto de partida. Os nomes canônicos são passados ao Whisper como vocabulário esperado, junto com o contexto da reunião, e as variações corrigem o que ainda sair errado antes de pesquisar ou gerar uma resposta.

Além do glossário, o app aprende sozinho os nomes próprios das notas indexadas: palavras escritas com maiúscula no meio da frase ("falar com a Paketá"), deixando de fora títulos, siglas e blocos de código. Os nomes ligados ao contexto da reunião vão para o vocabulário do Whisper, e um nome que saia escrito do jeito que soa ("Paquetá", "pacetá", "data prev") é trocado pela grafia das notas. Palavras que as notas usam em minúsculas, como "pacote", nunca são trocadas. Isso acontece uma vez, ao preparar a reunião; a correção de cada fala leva menos de 0,1 ms.

O mesmo comando `npm run whisper:build` baixa o detector de voz Silero (menos de 1 MB) para `models/vad/`. É ele que decide onde cada fala começa e termina; sem o arquivo, o app usa apenas o volume do áudio, que confunde ruído constante com fala.

### macOS

- Na primeira reunião o sistema pede permissão de **Gravação de Tela e Áudio do Sistema** e de **Microfone** para o app (em desenvolvimento, para o terminal ou o VS Code que o iniciou).
- Use fone de ouvido. Com caixas de som o microfone também ouve o cliente; o app descarta essa repetição na transcrição, mas ela fica na faixa do microfone da gravação.
- Se o `npm run dev` falhar com `Cannot read properties of undefined (reading 'isPackaged')`, o terminal herdou `ELECTRON_RUN_AS_NODE` (acontece no terminal do VS Code): rode `env -u ELECTRON_RUN_AS_NODE npm run dev`.
- O `ffmpeg` (`brew install ffmpeg`) é usado para gerar o `audio.m4a`; sem ele a gravação fica em WAV.

Para usar geração local, baixe um modelo no Ollama e ative-o em **Configurações**:

```bash
ollama pull gemma2:2b
```

## Provedores de IA

Clique em **Configurações**, na barra de cima da tela inicial, e cole a chave de API em **Adicionar chave de API**:

- O provedor é reconhecido pelo formato da chave: `sk-…` (OpenAI), `sk-ant-…` (Anthropic/Claude) ou `AIza…` (Google Gemini).
- Antes de salvar, o app consulta o provedor para confirmar que a chave funciona e lista os modelos de texto liberados para ela. Uma chave recusada não é salva.
- O modelo inicial de cada provedor é o mais rápido da família (por exemplo, Haiku no Claude e Flash no Gemini), porque a resposta precisa chegar durante a conversa. Dá para trocar em **Configurações** ou no campo **Modelo do agente** da tela inicial.
- O Ollama local é ativado na mesma janela: informe o endereço (padrão `http://localhost:11434`) e clique em **Detectar modelos**.

O modelo escolhido em **Modelo do agente** responde primeiro. Se ele falhar ou demorar mais de 15 segundos (45 no Ollama, que pode estar carregando o modelo), o app tenta os outros provedores configurados, na ordem OpenAI, Claude, Gemini e Ollama.

**Segurança das chaves:** as chaves, os modelos escolhidos e o endereço do Ollama ficam num único arquivo (`ai-providers.bin`, na pasta de dados do app), criptografado com o chaveiro do sistema (Keychain no macOS, DPAPI no Windows, libsecret no Linux) pelo `safeStorage` do Electron. A chave é lida só no processo principal, no momento de chamar o provedor: a tela recebe apenas uma versão mascarada (`sk-…a1b2`). Sem criptografia disponível no sistema, o app recusa salvar a chave. As variáveis `OPENAI_API_KEY`, `GEMINI_API_KEY` e `ANTHROPIC_API_KEY` não são mais lidas.

## Aparência e privacidade da janela

- Em **Configurações > Aparência** escolha o tema **Escuro** ou **Claro** e a opacidade do fundo durante a reunião (30% a 100%). Só o fundo fica transparente; o texto continua opaco. A tela de configuração fica sempre um pouco mais opaca que a da reunião.
- O switch **Privacidade**, na barra de cima, esconde a janela de prints e do compartilhamento de tela. Ele começa ligado sempre que o app abre; desligar vale só até fechar o app.

## Uso

```bash
npm run dev
```

1. Informe o contexto da reunião, os projetos e o caminho do vault.
2. Escolha o idioma e o modelo do agente (na primeira vez, cadastre uma chave em **Configurações**).
3. Clique em **Iniciar reunião**. As fontes locais são indexadas antes da captura começar.
4. Acompanhe a transcrição e a resposta sugerida; a interface lista os arquivos usados como base quando houver correspondência local.
5. Use o botão **Perguntar** para que a sua própria fala no microfone seja respondida pelo copiloto (no Linux e no Windows ele alterna a origem do áudio) e `Ctrl+Shift+S` para OCR.
6. Encerre a reunião para fechar a gravação.

## Histórico de reuniões

As reuniões gravadas aparecem em cartões no fim da tela inicial, quebrando linha conforme a largura da janela.

- **Enviar para o Harness** copia a `transcricao-final.md` para a pasta do Harness escolhida. Quando dá certo, a reunião ganha a marca **Enviada ao Harness** (com data e caminho no tooltip), registrada no próprio `reuniao.json`: o app não precisa abrir a pasta do Harness para saber. O botão passa a se chamar **Enviar de novo** e cria um arquivo novo, sem sobrescrever o anterior.
- **Apagar** pede confirmação e move a pasta inteira da reunião (áudio, transcrições e respostas) para a Lixeira do sistema, de onde ela pode ser recuperada. A reunião que está sendo gravada não pode ser apagada.

## O que fica salvo de cada reunião

Cada reunião gera uma pasta `meetings/<data>_<hora>_<contexto>/`:

| Arquivo                | Conteúdo                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `audio.m4a`            | Gravação estéreo: canal esquerdo com o cliente, canal direito com você.                           |
| `transcricao.md`       | Transcrição com horário e quem falou, seguida das perguntas respondidas e suas fontes.            |
| `transcricao.jsonl`    | A mesma transcrição, uma fala por linha, gravada durante a reunião.                               |
| `transcricao-final.md` | Transcrição refeita a partir da gravação depois da reunião (ver abaixo).                          |
| `reuniao.json`         | Contexto, transcrição, respostas, fontes, latências e envios ao Harness (lido pela tela inicial). |

### Transcrição final

Ao encerrar a reunião, o app transcreve a gravação de novo, em segundo plano e sem a pressa do tempo real, e grava `transcricao-final.md` na mesma pasta. Essa é a versão para documentação: o modelo ouve trechos inteiros de fala em vez de frases cortadas a cada pausa, e as frases seguidas de cada pessoa viram parágrafos. A transcrição feita ao vivo (`transcricao.md`) continua lá.

- O andamento aparece na tela inicial. Se você iniciar outra reunião ou fechar o app antes do fim, a transcrição final é interrompida.
- Para gerar ou refazer depois, abra a reunião no histórico e clique em **Gerar transcrição final**. Funciona para qualquer reunião gravada.
- Usa o modelo `large-v3` quando ele está em `models/` (`npm run whisper:model -- large-v3`, cerca de 3 GB); sem ele, usa o mesmo modelo da reunião. Para escolher outro, defina `WHISPER_FINAL_MODEL=arquivo-do-modelo.bin` no `.env`.
- Na tela inicial, mantenha o `large-v3-turbo` como modelo da reunião: o `large-v3` é mais preciso, mas lento demais para acompanhar a conversa ao vivo.

O áudio e o `transcricao.jsonl` são gravados durante a reunião; se o app fechar de forma inesperada, eles permanecem na pasta (o áudio em `audio-cliente.wav` e `audio-eu.wav`).

## Comandos

| Comando                 | Descrição                                |
| ----------------------- | ---------------------------------------- |
| `npm run dev`           | Inicia o app em desenvolvimento.         |
| `npm test`              | Executa os testes automatizados.         |
| `npm run lint`          | Executa o ESLint.                        |
| `npm run build`         | Gera os arquivos de produção.            |
| `npm run whisper:build` | Baixa e compila o adaptador Whisper.cpp. |
| `npm run whisper:model` | Baixa o modelo `large-v3-turbo`.         |

## Privacidade

A transcrição, a gravação e a indexação são locais. As reuniões gravadas contêm a voz de outras pessoas: avise os participantes e siga a política da empresa antes de gravar. Ao usar um provedor de IA em nuvem, a pergunta atual e os trechos locais selecionados para respondê-la são enviados ao provedor; com o Ollama local, nada sai do computador. As chaves de API ficam criptografadas (veja [Provedores de IA](#provedores-de-ia)). Não configure fontes com dados sensíveis sem autorização.

### Busca no Harness

As respostas tentam MCP do Obsidian, MCP do Omnisearch e REST em paralelo,
aceitando o primeiro resultado útil. O orçamento total dessas tentativas é de
850 ms; falha, ausência de resultados ou timeout retorna ao índice local.
Integrações com falha ficam 30 segundos sem novas tentativas. Uma nova pergunta
cancela a busca anterior. A pasta de Harness selecionada também entra no índice local.

O app reutiliza as configurações `obsidian` e `obsidian-omnisearch` de
`~/.codex/config.toml` somente quando `obsidian-fs` identifica o mesmo vault
selecionado. A REST usa o plugin Local REST API do vault selecionado quando seu
servidor HTTP local está habilitado. As credenciais ficam no processo principal.
Para uma instalação diferente, configure `HARNESS_MCP_URL`, `HARNESS_REST_URL`
e `HARNESS_API_KEY` no `.env`. Os endpoints devem servir o vault selecionado.
Nenhuma dessas integrações é obrigatória para a busca local funcionar.
