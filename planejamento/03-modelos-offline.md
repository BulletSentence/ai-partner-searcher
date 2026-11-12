# Modelos offline para transcrição em português

Máquina: MacBook Pro M5, 16 GB.

## Recomendação

**Whisper `large-v3-turbo` no Whisper.cpp com Metal**, que o projeto já usa. O modelo é bom para pt-BR; o problema estava em como o áudio era entregue a ele (janelas fixas de 3 s, sem vocabulário), não no modelo. Ver [01-diagnostico.md](01-diagnostico.md).

Já existe uma cópia do modelo nesta máquina (`~/Library/Application Support/github.com.thewh1teagle.vibe/ggml-large-v3-turbo.bin`, do app Vibe), então não é preciso baixar de novo.

## Opções

| Modelo                                       | Qualidade pt-BR                     | Velocidade no M5                     | Observação                                                                                                            |
| -------------------------------------------- | ----------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Whisper `large-v3-turbo`                     | Muito boa                           | Rápida (bem acima de tempo real)     | **Escolhido.** ~1,6 GB. Aceita prompt com vocabulário do domínio.                                                     |
| Whisper `large-v3`                           | A melhor da família                 | Algumas vezes mais lenta que o turbo | Vale testar se o turbo errar muito termo técnico; ~3 GB.                                                              |
| Whisper `large-v3-turbo` quantizado (`q5_0`) | Quase igual ao turbo                | Parecida                             | ~550 MB; útil para economizar memória.                                                                                |
| Whisper `small` / `medium`                   | Regular / boa                       | Muito rápida                         | Só para máquinas fracas; erra mais nome próprio e sigla.                                                              |
| NVIDIA Parakeet TDT 0.6b v3                  | Boa (multilíngue, inclui português) | Muito rápida, streaming nativo       | Exige outro runtime (MLX ou CoreML). Não aceita prompt de vocabulário. Alternativa a avaliar se a latência incomodar. |
| Vosk (o anterior)                            | Fraca                               | Muito rápida                         | Era a causa dos erros nas reuniões salvas.                                                                            |

## O que mais pesa na qualidade (em ordem)

1. Segmentar por pausa na fala em vez de tempo fixo.
2. Passar o vocabulário do domínio no prompt inicial.
3. Capturar o áudio do sistema direto (digital), não pelo microfone.
4. Beam search no resultado final.
5. Tamanho do modelo (turbo → large-v3).

Os números de velocidade e qualidade acima são de referência geral; a medição nesta máquina está em [04-status.md](04-status.md).
