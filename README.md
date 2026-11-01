# Copilot de Reuniões com IA

## Recursos

- Transcrição local em tempo real com Vosk, em português brasileiro ou inglês.
- Captura de áudio do sistema ou microfone em Linux com PulseAudio/PipeWire.
- Janela transparente, sem moldura e sempre no topo para acompanhar a reunião.
- Campo de contexto da reunião, caminhos de projetos e caminho do vault Obsidian.
- Índice local rápido para Markdown, texto, JSON, YAML e arquivos de código.
- Busca de trechos relevantes: somente os trechos selecionados acompanham a pergunta enviada à IA.
- Fallback local para o vault configurado quando uma integração MCP não estiver disponível.
- OCR de tela com `Ctrl+Shift+S` para incluir conteúdo visível no contexto.
- Histórico local de reuniões salvo em `meetings/`.
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

`PROJECT_PATHS` aceita um caminho por linha. O índice ignora diretórios pesados, como `node_modules`, `.git`, builds e a pasta interna `.obsidian`.

Edite `meeting-grammar.json` para registrar termos próprios, siglas e variações de transcrição. Cada entrada define o nome canônico e seus aliases; o app aplica as correções antes de pesquisar ou gerar uma resposta.

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
5. Use o botão de microfone para alternar a origem de áudio e `Ctrl+Shift+S` para OCR.
6. Encerre a reunião para salvar o histórico em `meetings/`.

## Comandos

| Comando | Descrição |
| --- | --- |
| `npm run dev` | Inicia o app em desenvolvimento. |
| `npm test` | Executa os testes do índice local. |
| `npm run lint` | Executa o ESLint. |
| `npm run build` | Gera os arquivos de produção. |

## Privacidade

A transcrição e a indexação são locais. Ao usar um provedor de IA em nuvem, a pergunta atual e os trechos locais selecionados para respondê-la podem ser enviados ao provedor. Não configure fontes com dados sensíveis sem autorização.
