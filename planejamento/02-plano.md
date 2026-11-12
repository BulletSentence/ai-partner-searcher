# Plano de implementação

Ver o diagnóstico em [01-diagnostico.md](01-diagnostico.md) e a escolha de modelo em [03-modelos-offline.md](03-modelos-offline.md). O andamento fica em [04-status.md](04-status.md).

## 1. Transcrição em tempo real (prioridade)

Reescrever o adaptador `native/whisper-stream/main.cpp`:

- **Segmentar por fala, não por tempo.** Detector de voz (VAD) fecha a frase quando há cerca de 0,6 s de silêncio; corte forçado só em falas muito longas (~15 s), e no ponto mais silencioso. Guarda 0,3 s antes do início da fala para não perder a primeira sílaba.
- **Dois canais no mesmo processo**, com um único modelo carregado: canal 0 = áudio do sistema (cliente), canal 1 = microfone (você). Protocolo de entrada com cabeçalho `[canal][tamanho]` por bloco.
- **Vocabulário no prompt inicial**: termos de `meeting-grammar.json` + contexto da reunião + final da fala anterior, para o modelo já esperar "FIDC", "Dataprev", "averbação" etc.
- **Beam search (5)** no resultado final; parcial rápido (greedy) a cada ~1,5 s enquanto a pessoa fala, para a tela continuar em tempo real.
- **Filtro de alucinação**: descartar trechos com alta probabilidade de "sem fala" e frases típicas de silêncio ("Legendas pela comunidade…", "Obrigado por assistir").
- Saída em JSON por linha: `ready`, `partial`, `final` com canal e tempos de início/fim.

Modelo: `large-v3-turbo` com Metal (GPU do Mac).

## 2. Captura de áudio

- macOS: capturar **sistema e microfone ao mesmo tempo** no renderer (loopback + `getUserMedia`), cada um marcado com o seu canal.
- Linux/Windows: manter o comportamento atual (uma origem por vez), apenas marcando o canal.
- O botão "Perguntar" deixa de trocar a origem de áudio: passa a indicar que a sua fala no microfone também deve gerar resposta do copiloto.
- Descartar fala do microfone que for eco do cliente (texto quase igual ao do canal do sistema no mesmo instante) — acontece ao usar caixas de som em vez de fone.

## 3. Gravação e histórico da reunião

Uma pasta por reunião em `meetings/<data>_<hora>_<contexto>/` (ou em `MEETINGS_DIR`, se definido):

| Arquivo             | Conteúdo                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `audio.m4a`         | Gravação estéreo: esquerda = cliente, direita = você. Gerado ao encerrar, via ffmpeg. Sem ffmpeg, ficam os WAV. |
| `transcricao.md`    | Transcrição legível com horário e quem falou.                                                                   |
| `transcricao.jsonl` | Mesma transcrição, uma fala por linha, gravada **ao vivo** (não se perde se o app fechar).                      |
| `reuniao.json`      | Contexto, perguntas, respostas, fontes consultadas e latências.                                                 |

A reunião é salva sempre, mesmo sem nenhuma resposta da IA. A tela de histórico continua lendo os arquivos antigos.

## 4. Perguntas e respostas

- Resposta automática só para perguntas do **cliente** (canal do sistema); a sua fala é transcrita e gravada, mas não dispara resposta, exceto no modo "Perguntar".
- Enviar à IA as últimas falas da conversa junto com a pergunta, e usá-las também na busca local.
- Detector de perguntas passa a trabalhar com frases inteiras e pontuadas pelo Whisper.

## 5. Busca no Obsidian e no projeto

- **Cota por local**: o vault e cada projeto têm o seu próprio limite, para o projeto não ocupar o índice inteiro. Vault indexado primeiro.
- Ignorar pastas ocultas (`.claude`, `.git`…), `assets`, lockfiles e arquivos minificados.
- Pontuação BM25 (peso por raridade do termo), sem palavras vazias, sem distinção de acento; Markdown vale mais que JSON/código.

## 6. Documentação e testes

- Atualizar README e `.env.example`.
- Testes: índice/busca, detector de perguntas, gravador de reunião.
- Teste real do adaptador com áudio em português (ffmpeg + voz do macOS).

## Fora deste plano

- Diarização (separar vários clientes entre si): hoje só se distingue cliente × você, pelo canal.
- Resumo automático da reunião ao encerrar.
- Troca dos modelos de resposta (OpenAI/Gemini/Claude/Ollama).
