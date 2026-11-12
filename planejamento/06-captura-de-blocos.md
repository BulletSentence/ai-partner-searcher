# Captura e corte dos blocos de áudio (12/11/2026)

Pedido: melhorar as estratégias de captura dos blocos de áudio, para otimizar e ficar melhor.

## O que mudou

| Etapa                                | Antes                                                                                                      | Agora                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Captura na tela (macOS)              | `ScriptProcessor` na thread da interface, blocos de 256 ms; pode perder áudio quando a janela está ocupada | `AudioWorklet` na thread de áudio, blocos de 100 ms; o `ScriptProcessor` fica só como reserva                                           |
| Microfone                            | Ganho automático ligado                                                                                    | Ganho automático desligado (ele amplifica o ruído nas pausas e esconde o fim da fala); cancelamento de eco e redução de ruído continuam |
| Detecção de fala                     | Volume acima do ruído de fundo                                                                             | Detector neural Silero (modelo de 885 KB que o Whisper.cpp já suporta); volume fica como reserva se o modelo faltar                     |
| Ruído que começa no meio da fala     | O ruído de fundo só era medido em silêncio, então a pausa deixava de ser detectada                         | O nível de ruído também é acompanhado durante a fala                                                                                    |
| Fala longa sem pausa                 | Cortada aos 22 s onde estivesse, até no meio de uma palavra                                                | Cortada no instante mais silencioso dos últimos 5 s; o resto segue como a próxima fala                                                  |
| Texto parcial enquanto a pessoa fala | O modelo processava sempre uma janela de 30 s                                                              | O modelo olha só o áudio que existe, o que barateia os parciais de falas curtas                                                         |
| Ao vivo e transcrição final          | Dois cortadores diferentes                                                                                 | O mesmo cortador, com limites diferentes (22 s ao vivo, 28 s na final)                                                                  |

## Resultado dos testes (áudio sintético, `large-v3-turbo`)

| Áudio                            | Corte por volume                                   | Silero                              |
| -------------------------------- | -------------------------------------------------- | ----------------------------------- |
| Ruído branco, 8 s                | Gerou "Legenda por Sônia Ruberti"                  | Nenhum bloco                        |
| Ruído rosa, 8 s                  | Gerou "Sous-titrage Société Radio-Canada"          | Nenhum bloco                        |
| Tom contínuo, 6 s                | Gerou "."                                          | Nenhum bloco                        |
| Cliques tipo teclado, 8 s        | Nenhum bloco                                       | Nenhum bloco                        |
| Fala com ruído desde o início    | 4 falas, certo                                     | 4 falas, certo                      |
| Fala com ruído que entra aos 4 s | 4 falas, certo (antes desta mudança virava uma só) | 4 falas, certo                      |
| Monólogo de 49 s quase sem pausa | 4 blocos, cortados em fim de oração                | 3 blocos, cortados em fim de oração |

- Tempo de transcrição por fala com Silero: 0,77 a 0,96 s, igual ao de antes (0,79 a 1,02 s).
- A captura por `AudioWorklet` foi testada dentro do Electron com um tom gerado: blocos de 3.200 bytes (100 ms) a 16 kHz, sem falhas.
- As frases inventadas que apareceram no corte por volume entraram na lista de descarte, para o caso de o modelo Silero não estar instalado.

## O que não foi testado

A captura real de sistema + microfone numa chamada. O teste do `AudioWorklet` usou um tom sintético, não o áudio do macOS.

## Arquivos

- `native/whisper-stream/main.cpp`: `VoiceDetector`, `Segmenter`, opção `--vad-model`.
- `src/renderer/public/pcm-capture-worklet.js` e `src/renderer/src/App.jsx`: captura.
- `src/main/transcriber.js`: localiza o modelo em `models/vad/` (ou `WHISPER_VAD_MODEL`).
- `scripts/build-whisper-stream.sh`: baixa o modelo Silero junto com o build.

## Ideias que ficaram de fora

- Fechar a fala mais cedo quando o texto parcial já termina em "?" (resposta mais rápida, risco de cortar perguntas compostas).
- Cancelamento de eco usando o áudio do sistema como referência, para quem usa caixas de som.
