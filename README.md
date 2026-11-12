# Copilot de Reuniões com IA

## Recursos

- Transcrição local em tempo real com Whisper.cpp, em português brasileiro ou inglês, cortada nas pausas da fala e com o vocabulário da reunião informado ao modelo.
- Gravação do áudio e da transcrição de cada reunião em uma pasta própria dentro de `meetings/`.
- No macOS, captura simultânea do áudio do sistema (cliente) e do microfone (você), com a identificação de quem falou.
- Resposta automática apenas para perguntas do cliente; a sua fala é transcrita e gravada, mas não dispara respostas.
- Captura de áudio do sistema ou microfone em Linux com PulseAudio/PipeWire.
- Janela transparente, sem moldura e sempre no topo para acompanhar a reunião.
- Campo de contexto da reunião, caminhos de projetos e caminho do vault Obsidian.
- Índice local rápido para Markdown, texto, JSON, YAML e arquivos de código, com o vault indexado primeiro e uma cota própria para cada pasta.
- Busca de trechos relevantes: somente os trechos selecionados acompanham a pergunta enviada à IA.
- Fallback local para o vault configurado quando uma integração MCP não estiver disponível.
- OCR de tela com `Ctrl+Shift+S` para incluir conteúdo visível no contexto.
- Histórico inclui provedor, fontes consultadas e métricas de latência por resposta.
- Roteamento entre OpenAI, Gemini, Claude e Ollama local.

## Instalação

```bash
nvm use
npm install
cp .env.example .env
```

Configure as chaves desejadas e, se preferir valores padrão, edite `.env`:

```env
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=

MEETING_CONTEXT=
PROJECT_PATHS=/caminho/para/projeto-1
OBSIDIAN_VAULT_PATH=/caminho/para/ObsVaultCredifit
MEETING_LANGUAGE=pt-BR
MEETING_USE_OLLAMA=false
OPENAI_MODEL=gpt-6-luna
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

Edite `meeting-grammar.json` para registrar termos próprios, siglas e variações de transcrição. Os nomes canônicos são passados ao Whisper como vocabulário esperado, junto com o contexto da reunião, e os aliases corrigem o que ainda sair errado antes de pesquisar ou gerar uma resposta. Vale incluir aqui os nomes de clientes, fundos e produtos de cada reunião.

O mesmo comando `npm run whisper:build` baixa o detector de voz Silero (menos de 1 MB) para `models/vad/`. É ele que decide onde cada fala começa e termina; sem o arquivo, o app usa apenas o volume do áudio, que confunde ruído constante com fala.

### macOS

- Na primeira reunião o sistema pede permissão de **Gravação de Tela e Áudio do Sistema** e de **Microfone** para o app (em desenvolvimento, para o terminal ou o VS Code que o iniciou).
- Use fone de ouvido. Com caixas de som o microfone também ouve o cliente; o app descarta essa repetição na transcrição, mas ela fica na faixa do microfone da gravação.
- Se o `npm run dev` falhar com `Cannot read properties of undefined (reading 'isPackaged')`, o terminal herdou `ELECTRON_RUN_AS_NODE` (acontece no terminal do VS Code): rode `env -u ELECTRON_RUN_AS_NODE npm run dev`.
- O `ffmpeg` (`brew install ffmpeg`) é usado para gerar o `audio.m4a`; sem ele a gravação fica em WAV.

Para usar geração local:

```bash
ollama pull gemma2:2b
```

## Uso

```bash
npm run dev
```

1. Informe o contexto da reunião, os projetos e o caminho do vault.
2. Escolha idioma e provedor.
3. Clique em **Iniciar reunião**. As fontes locais são indexadas antes da captura começar.
4. Acompanhe a transcrição e a resposta sugerida; a interface lista os arquivos usados como base quando houver correspondência local.
5. Use o botão **Perguntar** para que a sua própria fala no microfone seja respondida pelo copiloto (no Linux e no Windows ele alterna a origem do áudio) e `Ctrl+Shift+S` para OCR.
6. Encerre a reunião para fechar a gravação.

## O que fica salvo de cada reunião

Cada reunião gera uma pasta `meetings/<data>_<hora>_<contexto>/`:

| Arquivo                | Conteúdo                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `audio.m4a`            | Gravação estéreo: canal esquerdo com o cliente, canal direito com você.                    |
| `transcricao.md`       | Transcrição com horário e quem falou, seguida das perguntas respondidas e suas fontes.     |
| `transcricao.jsonl`    | A mesma transcrição, uma fala por linha, gravada durante a reunião.                        |
| `transcricao-final.md` | Transcrição refeita a partir da gravação depois da reunião (ver abaixo).                   |
| `reuniao.json`         | Contexto, transcrição, respostas, fontes consultadas e latências (lido pela tela inicial). |

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

A transcrição, a gravação e a indexação são locais. As reuniões gravadas contêm a voz de outras pessoas: avise os participantes e siga a política da empresa antes de gravar. Ao usar um provedor de IA em nuvem, a pergunta atual e os trechos locais selecionados para respondê-la podem ser enviados ao provedor. Não configure fontes com dados sensíveis sem autorização.
