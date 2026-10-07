# Foco

**Avaliações sem complicação.**

O Foco é uma aplicação web para criar avaliações, compartilhá-las por link e revisar as respostas em um só lugar. Combina questões objetivas e abertas, controle de tempo e registro transparente de sinais de foco durante a aplicação.

Os avaliadores acessam suas contas com autenticação. Os participantes respondem pelo link, sem precisar criar uma conta.

## Funcionalidades

- **Criação de avaliações:** título, instruções, duração e perguntas de múltipla escolha ou resposta livre.
- **Compartilhamento por link:** acesso do participante sem expor o gabarito da avaliação online.
- **Prévia:** conferência da experiência antes da aplicação, sem registrar uma entrega real.
- **Controle de tempo:** cronômetro para a avaliação inteira e envio ao término do prazo.
- **Retomada de respostas:** preservação local das respostas, da posição e do prazo para continuar no mesmo navegador.
- **Resultados:** consulta das tentativas, correção das questões objetivas e revisão das respostas abertas.
- **Importação e exportação:** arquivos JSON para transferência de dados e backup.
- **Tema claro e escuro:** preferência do sistema, alternância manual e persistência da escolha.

## Como funciona

1. O avaliador entra na conta, cria uma avaliação e define as perguntas e o tempo disponível.
2. Após salvar e conferir a prévia, compartilha o link com os participantes.
3. Cada participante responde à avaliação dentro do prazo.
4. O envio é confirmado pelo Supabase e fica disponível na área de resultados do avaliador.

Em caso de falha no envio, a aplicação mantém uma cópia local pendente para uma nova tentativa. Uma resposta só é considerada entregue após a confirmação do servidor.

## Tecnologias

| Camada | Tecnologia |
| --- | --- |
| Interface | HTML, CSS e JavaScript com módulos nativos |
| Autenticação e dados | Supabase Auth, PostgreSQL e chamadas HTTP/RPC |
| Persistência local | `localStorage` |
| Servidor de desenvolvimento | Node.js, sem dependências adicionais |
| Build | Script Node.js que prepara os arquivos estáticos |
| Hospedagem | Vercel |
| Testes | Scripts Node.js com verificações automatizadas |

## Executar localmente

É necessário ter Node.js instalado e um navegador moderno. Não é necessário executar `npm install`.

```sh
git clone https://github.com/alucardtdrk/Focus.git
cd Focus
node server.mjs
```

Abra **http://localhost:3000**. Para encerrar o servidor, pressione `Ctrl+C`.

O acesso às avaliações e aos resultados online depende de um projeto Supabase configurado e de uma conta de avaliador válida.

## Configuração do Supabase

As configurações públicas do cliente ficam em `src/supabase-config.js`:

- `SUPABASE_URL`: endereço do projeto Supabase.
- `SUPABASE_KEY`: chave **publishable** destinada ao navegador.

Essa chave é pública. A proteção dos dados depende das políticas de acesso e das funções do banco. Nunca coloque senhas, chaves secretas ou uma chave `service_role` nos arquivos da aplicação.

As contas de avaliadores são criadas pelo painel do Supabase. A aplicação utiliza login por e-mail e senha; participantes não precisam de conta.

**Os scripts SQL e os documentos internos de configuração são mantidos fora deste repositório.** Para usar um novo projeto Supabase, obtenha esses scripts com o responsável pelo projeto, aplique o esquema e valide as permissões antes de usar a aplicação. Clonar este repositório não cria nem configura o banco de dados.

## Publicar na Vercel

Importe este repositório na Vercel. A configuração de build já está definida em `vercel.json`:

| Configuração | Valor |
| --- | --- |
| Framework Preset | Other |
| Build Command | `node build.mjs` |
| Output Directory | `dist` |
| Root Directory | Raiz do repositório |

O build copia apenas a interface e os recursos públicos para `dist/`. O servidor local, os testes e este README não fazem parte dos arquivos publicados pelo build.

Após a publicação, abra o domínio da aplicação e gere os links de compartilhamento nesse endereço. Links criados em `localhost` não podem ser usados por outros participantes.

## Verificação

Execute os testes e prepare o build com:

```sh
node tests/theme.test.mjs
node tests/supabase.test.mjs
node tests/app.test.mjs
node build.mjs
```

Os testes verificam o tema, a integração HTTP simulada e os fluxos de persistência, envio, revisão e retomada. Eles não modificam o Supabase e não substituem a validação das permissões e do fluxo completo no ambiente real.

## Estrutura do projeto

```text
Focus/
├── public/                 # Recursos públicos da interface
├── src/
│   ├── app.js              # Fluxos de avaliações e resultados
│   ├── styles.css          # Estilos da aplicação
│   ├── supabase.js         # Cliente de autenticação e dados
│   ├── supabase-config.js  # Configurações públicas do Supabase
│   └── theme.js            # Preferência de tema
├── tests/                  # Verificações automatizadas
├── build.mjs               # Preparação dos arquivos estáticos
├── index.html              # Página de entrada
├── server.mjs              # Servidor de desenvolvimento
└── vercel.json             # Configuração de publicação
```

## Privacidade e limites

- A aplicação registra mudanças de aba, perda de foco da janela e cliques fora da área da prova. Esses eventos são sinais técnicos e **não constituem prova de fraude**.
- A retomada depende dos dados locais disponíveis no mesmo navegador e endereço. Limpar o armazenamento pode remover respostas ainda não entregues.
- Evite editar avaliações durante uma aplicação: a entrega de uma versão desatualizada pode ser recusada.
- O envio público é destinado a grupos conhecidos por link; não há CAPTCHA ou limitação de frequência implementados nesta versão.
- Mantenha backups por exportação JSON e valide o fluxo completo antes de aplicar uma avaliação.
