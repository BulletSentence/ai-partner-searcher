# Status (atualizado em 12/11/2026)

Plano em [02-plano.md](02-plano.md).

## Feito e verificado

| Item                                                                                                     | Onde                                               | Como foi verificado                                                                           |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Adaptador Whisper reescrito: corte por pausa, dois canais, vocabulário no prompt, beam search, parciais  | `native/whisper-stream/main.cpp`                   | Compilado nesta máquina e executado com áudio em português (voz do macOS)                     |
| Transcritor com protocolo de dois canais e encerramento que espera a última frase                        | `src/main/transcriber.js`                          | Teste de ponta a ponta com o adaptador real                                                   |
| Filtro de alucinação (sem fala, baixa confiança, trecho longo com poucas palavras) e de eco do microfone | `src/main/transcriptFilter.js`                     | Testes automatizados + ruído branco, ruído rosa e tom puro no adaptador real                  |
| Gravação da reunião: áudio, `transcricao.md`, `transcricao.jsonl`, `reuniao.json`                        | `src/main/meetingRecorder.js`                      | Testes automatizados + geração real do `audio.m4a` estéreo com ffmpeg                         |
| Detector de perguntas ignora cumprimentos e "né?"                                                        | `src/main/questionDetector.js`                     | Testes automatizados                                                                          |
| Busca BM25 com cota por local, vault primeiro, pastas ocultas ignoradas                                  | `src/main/contextService.js`                       | Testes automatizados + índice real do vault e do repositório `api`                            |
| IA recebe as falas anteriores junto com a pergunta                                                       | `src/main/aiService.js`, `src/main/index.js`       | Só build e leitura do código                                                                  |
| Captura simultânea de sistema + microfone e rótulo de quem falou na tela                                 | `src/renderer/src/App.jsx`, `src/preload/index.js` | Só build; o app abre sem erros, mas **uma reunião real pela interface ainda não foi testada** |

Acrescentado em 12/11:

| Item                                                                                                             | Onde                                                                           | Como foi verificado                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcrição final a partir da gravação ([05](05-transcricao-final.md))                                           | `src/main/finalTranscription.js`, modo `--file` do adaptador                   | Executada sobre uma gravação `audio.m4a` real gerada pelo gravador, com `large-v3` e `large-v3-turbo`; botão e andamento na tela só passaram pelo build |
| Detector de voz Silero, corte no ponto mais silencioso, captura por AudioWorklet ([06](06-captura-de-blocos.md)) | `native/whisper-stream/main.cpp`, `src/renderer/public/pcm-capture-worklet.js` | Adaptador testado com ruído, cliques, fala com ruído e monólogo; worklet testado dentro do Electron com tom gerado                                      |

`npm test`: 9 testes, todos passando. `npm run build`: ok. ESLint: 0 erros.

## Medições nesta máquina (M5, `large-v3-turbo`, Metal)

- Cada fala de 5 a 8 s é transcrita em cerca de 0,8 s.
- Com o vocabulário no prompt: "Dataprev", "OAuth", "cessão", "Paketa" saíram certos. Sem ele, o mesmo áudio deu "data prev", "alt", "sessão", "Paquetá".
- Erro que restou no áudio de teste: "webhook" virou "e-book" (voz sintética; conferir com voz real).
- Índice real: 7.428 arquivos, 42.070 trechos, 8,4 s para indexar, busca em 6 a 15 ms, cerca de 400 MB de memória. As três perguntas de teste trouxeram notas do HARNESS (por exemplo `HARNESS/tasks/REUNIAO_RUBICON2_API_CESSAO.md`).

O áudio de teste é voz sintética limpa. A qualidade com voz real de chamada (compressão, sotaque, gente falando junto) ainda precisa ser conferida numa reunião.

## Preparação feita nesta máquina

- CMake instalado via Homebrew.
- Whisper.cpp baixado em `.cache/` e adaptador compilado em `bin/whisper-stream`.
- Modelo `ggml-large-v3.bin` (3 GB) baixado em `models/` para a transcrição final, e o detector de voz Silero em `models/vad/`.
- Modelo `ggml-large-v3-turbo.bin` copiado para `models/` a partir do app Vibe (cópia APFS, não ocupa espaço extra).

## Pendente

1. Rodar uma reunião real pela interface no macOS e conferir: permissão de microfone, as duas faixas no `audio.m4a`, rótulos Cliente/Eu.
2. Conferir, na mesma reunião, a transcrição final (`transcricao-final.md`) e quanto tempo ela leva.
3. Ajustar os limites do detector de pausa se cortar cedo ou tarde demais com voz real (constantes no topo de `main.cpp`).
4. Completar `meeting-grammar.json` com nomes de clientes, fundos e produtos.
5. Fora do plano, a decidir: resumo automático ao encerrar; salvar a transcrição direto no vault (`MEETINGS_DIR`); diarização de vários clientes.

## Limitações conhecidas

- Linux e Windows continuam com uma origem de áudio por vez (sistema ou microfone); a gravação tem só a faixa capturada.
- Sem fone, a faixa do microfone na gravação contém também a voz do cliente.
- Respostas curtas de uma palavra ("Sim.", "Não.") com baixa confiança são descartadas da transcrição.

## Interface responsiva (12/11/2026)

- As telas de configuração e de reunião ocupam a janela inteira e acompanham o redimensionamento (mínimo 420 × 360). Antes eram cartões fixos de 860 × 600.
- O tamanho base do texto varia com a largura da janela, de cerca de 12 px a 14 px; como o app usa `rem`, tudo encolhe junto.
- A janela de configuração pode ser arrastada pela barra de cima. A barra ficava dentro da área com rolagem, onde o Electron ignora regiões de arrastar; agora só o corpo do formulário rola.
- Cabeçalhos: botões viram ícone + rótulo curto, com o texto completo no tooltip. Abaixo de 760 px ficam só os ícones; abaixo de 560 px somem os detalhes secundários (nome do provedor, tempos, contagem de arquivos). Títulos ficam numa linha, com reticências.
- Verificado renderizando as duas telas no Electron, com a API do app simulada, em 900, 640 e 460 px de largura. O arrasto em si não foi testado com o mouse.
