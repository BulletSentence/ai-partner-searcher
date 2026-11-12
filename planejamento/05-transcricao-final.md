# Transcrição final a partir da gravação (12/11/2026)

Pedido: usar a gravação salva para, ao final, transcrever com calma, sem ser em tempo real, e deixar a reunião documentada.

## Como funciona

1. Ao encerrar a reunião, depois de salvar áudio e transcrição ao vivo, o app inicia a transcrição final em segundo plano.
2. Cada lado da gravação (cliente e você) é transcrito separadamente a partir do `audio.m4a` (ou dos WAV, se o ffmpeg não estiver instalado).
3. O resultado é gravado em `transcricao-final.md`, na pasta da reunião, e em `reuniao.json` (campo `finalTranscript`). A transcrição ao vivo (`transcricao.md`) não é alterada.
4. O histórico mostra a versão final quando ela existe e tem o botão **Gerar transcrição final** / **Refazer transcrição final**, que funciona para qualquer reunião gravada.

## O que muda em relação à transcrição ao vivo

|                                     | Ao vivo                                       | Final                                                   |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| Tamanho do bloco entregue ao modelo | Uma fala, fechada na primeira pausa de 0,64 s | Falas vizinhas juntas, até 28 s                         |
| Contexto                            | Só o vocabulário                              | Vocabulário + fim do bloco anterior                     |
| Modelo                              | `large-v3-turbo`                              | `large-v3`, se estiver em `models/`; senão o da reunião |
| Texto                               | Uma linha por fala                            | Parágrafos por pessoa                                   |
| Prazo                               | Menos de 1 s por fala                         | Minutos depois da reunião                               |

## Decisões

- **Roda depois de salvar, não durante o encerramento.** A reunião já está segura no disco; fechar o app ou iniciar outra reunião apenas interrompe a transcrição final, que pode ser refeita pelo histórico.
- **Lê a gravação, não a memória.** Assim vale para reuniões antigas e para refazer com outro modelo.
- **Blocos cortados em pausas, sem marcação de tempo interna do Whisper.** Testei deixar o Whisper marcar os tempos em blocos longos: o turbo piorou ("integração ou com", "acessão") e arredondou os tempos para segundos inteiros. Cortar em pausas deu texto melhor nos dois modelos; o horário mostrado é o do início de cada bloco.
- **`large-v3` como padrão quando disponível.** Baixei o modelo (3 GB) para comparar.

## Medições (M5, áudio sintético em português)

| Modelo           | 115 s de fala contínua                       | "cessão dos contratos" (6 ocorrências)            |
| ---------------- | -------------------------------------------- | ------------------------------------------------- |
| `large-v3`       | 22,5 s (cerca de 5× mais rápido que o áudio) | 6 certas                                          |
| `large-v3-turbo` | 7,8 s (cerca de 15×)                         | 2 certas; as outras viraram "sessão" ou "acessão" |

Estimativa para 1 hora de reunião com `large-v3`: de 10 a 20 minutos, dependendo de quanto se fala. Não medi com uma reunião real.

Erros que ficaram no áudio de teste, nos dois modelos: "webhook" virou "e-book" e, no `large-v3`, "com o time" virou "com o Ultime". As duas palavras são estrangeiras lidas por voz sintética; conferir com voz real.

## Arquivos

- `native/whisper-stream/main.cpp`: modo `--file`.
- `src/main/finalTranscription.js`: lê as faixas, roda o adaptador, monta e grava o texto.
- `src/main/index.js`: dispara ao encerrar, cancela ao iniciar outra reunião, atende o botão do histórico.
- Variáveis: `WHISPER_FINAL_MODEL`, `WHISPER_FINAL_BEAM_SIZE`.
