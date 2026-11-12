# Diagnóstico do projeto (11/11/2026)

Revisão do Copilot de Reuniões frente ao objetivo: gravar o áudio das reuniões, salvar a transcrição, ouvir em tempo real e responder às perguntas do cliente com base no harness do Obsidian e no projeto indicado.

## O que o objetivo pede e o que existia

| Objetivo                                   | Situação encontrada                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Salvar o áudio da reunião                  | Não existia. O áudio era descartado após a transcrição.                                                  |
| Salvar a transcrição                       | Não existia. Só era salvo o histórico de perguntas enviadas à IA, e apenas quando houve alguma resposta. |
| Ouvir em tempo real e responder ao cliente | Existia, mas com transcrição ruim e só uma origem de áudio por vez (sistema **ou** microfone).           |
| Buscar no harness do Obsidian e no projeto | Existia, mas o índice quase nunca chegava ao vault (ver abaixo).                                         |

## Por que a transcrição estava fraca

1. **As reuniões salvas foram transcritas pelo Vosk, não pelo Whisper.** Os arquivos em `meetings/` são de 01/11 e 03/11; a troca para Whisper.cpp entrou em 08/11. Frases como "como autenticá-los na pele externa" (era "como autenticar na API externa") e "quem matou vitória" vêm do Vosk.
2. **Nesta máquina o Whisper nunca rodou.** `bin/` e `models/` estavam vazios e o CMake não estava instalado, então o app nem conseguia iniciar uma reunião.
3. **O adaptador Whisper cortava o áudio em janelas fixas de 3 segundos** (`native/whisper-stream/main.cpp`). Consequências:
   - palavras cortadas ao meio na fronteira de cada janela;
   - cada pedaço de 3 s era tratado como uma frase completa, então a pergunta do cliente chegava em fragmentos ao detector de perguntas e à busca;
   - sem detecção de silêncio, o Whisper recebe trechos sem fala e inventa texto.
4. **Sem vocabulário do domínio.** `no_context = true` e nenhum prompt inicial: o modelo não sabia que "FIDC", "Dataprev", "averbação", "Paketá" eram palavras prováveis. A correção acontecia só depois, por substituição de texto em `meeting-grammar.json`, que só cobre os erros previstos.
5. **Decodificação gulosa** (greedy), sem beam search.

## Outros problemas encontrados

- **Só uma origem de áudio por vez.** Ou o sistema (cliente) ou o microfone (você). Para gravar e transcrever a reunião inteira é preciso capturar os dois ao mesmo tempo e saber quem falou.
- **A busca local não alcançava o vault.** O índice tem teto de 500 arquivos e 3.000 trechos e indexa primeiro o projeto. O repositório `api` sozinho estoura o teto, inclusive com cópias em `.claude/worktrees/` e JSONs de `assets/`. As respostas salvas mostram isso: os trechos usados eram cláusulas de CCB em JSON, sem relação com a pergunta.
- **Pontuação da busca muito simples.** Conta palavras em comum sem peso por raridade, sem ignorar palavras vazias ("como", "que", "para") e sensível a acento.
- **A IA recebia só a frase da pergunta**, sem as falas anteriores da conversa.
- **O texto do microfone era rotulado como pergunta da reunião**, misturando a sua fala com a do cliente.
