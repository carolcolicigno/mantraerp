# Mantra ERP

Sistema de gestão da agência Mantra: financeiro, faturamento e fiscal, compras e fornecedores,
vendas e clientes, contratos, projetos e serviços, pessoas, relatórios gerenciais e aprovações e acessos.

Requer Node.js 22. Localmente usa um banco SQLite embutido; em produção (Vercel) usa Postgres pela variável `DATABASE_URL`.

## Rodar localmente

```bash
npm install
npm start
# abre em http://localhost:3000
```

Na primeira execução o banco é criado em `data/mantra.db` com dados de exemplo e quatro usuários
(admin, financeiro, gestor e colaborador). A **senha inicial** aparece uma única vez no terminal;
para escolher a senha, rode `SEED_PASSWORD='sua-senha' npm start` antes do primeiro acesso.
Cada pessoa pode trocar a própria senha pelo ícone de chave no menu lateral.

## Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | — | Conexão Postgres (obrigatória na Vercel) |
| `DB_PATH` | `data/mantra.db` | Arquivo do banco SQLite (uso local) |
| `SEED_PASSWORD` | aleatória | Senha inicial dos usuários de exemplo (só na criação do banco) |
| `COOKIE_SECURE` | — | Use `1` em produção com HTTPS |
| `ASAAS_API_KEY` | — | Chave da API do Asaas (ativa boleto/Pix e NFS-e) |
| `ASAAS_ENV` | `sandbox` | Use `producao` para cobrar e emitir de verdade |
| `ASAAS_WEBHOOK_TOKEN` | — | Token que o Asaas envia no webhook `/api/asaas/webhook` |

## Publicar

### Vercel

O projeto já vem configurado (`vercel.json`): os arquivos de `public/` são servidos como site estático
e `api/index.js` atende todas as rotas `/api/*`. No projeto da Vercel:

1. Em **Storage → Create Database → Neon (Postgres)**, crie o banco e conecte ao projeto
   (isso cria a variável `DATABASE_URL`).
2. Defina `SEED_PASSWORD` (senha inicial dos usuários) e `COOKIE_SECURE=1`.
3. Faça um novo deploy. Na primeira requisição o banco é preparado com os dados de exemplo.

### Docker / outro servidor

```bash
docker build -t mantra-erp .
docker run -p 3000:3000 -v mantra-data:/data -e COOKIE_SECURE=1 mantra-erp
```

Faça backup do arquivo do banco (`/data/mantra.db`) regularmente.

## Integrações e automações

- **Extrato bancário**: em Financeiro → Conciliação, importe OFX ou CSV; cada movimento é casado
  com Contas a pagar/receber pelo valor e pela data (±7 dias) e o lançamento é baixado e conciliado.
- **Cobranças recorrentes**: contratos vigentes geram sozinhos a parcela do mês atual e do próximo
  (com reajuste anual), no dia de vencimento definido no contrato, sem duplicar lançamentos.
- **Asaas**: com `ASAAS_API_KEY`, "Gerar boleto/Pix" cria a cobrança (link e Pix copia-e-cola) e
  "Emitir NFS-e" emite a nota pela prefeitura. Cadastre o webhook para baixar pagamentos e
  atualizar notas automaticamente. Configure o serviço municipal e o ISS em Configurações.

## Cadastros e anexos

- Clientes (logo, razão social, CNPJ com consulta à Receita via BrasilAPI, endereço com consulta de
  CEP via ViaCEP, contatos e e-mail do financeiro), fornecedores e colaboradores (foto, CPF, RG,
  contatos, endereço, contato de emergência e dados bancários).
- Documentos anexados a clientes, fornecedores, contratos, colaboradores e projetos: PDF, imagens,
  Word, Excel, CSV ou TXT, até 3 MB cada, guardados no próprio banco (tabela `arquivos`).
  O plano gratuito do Neon tem 0,5 GB: para muitos arquivos, considere um plano maior.

## Segurança

- Senhas guardadas com scrypt + salt; sessões em cookie `HttpOnly` / `SameSite=Strict`.
- Permissões por perfil verificadas no servidor (não só na tela), inclusive quem pode aprovar
  despesas e compras; salários só são enviados a quem tem acesso ao módulo Pessoas.
- Limite de 10 tentativas de login a cada 15 minutos por IP.
- Toda alteração fica registrada no histórico com o usuário autenticado.
- Controle de versão por registro: se duas pessoas editam o mesmo cadastro, a segunda é avisada
  em vez de sobrescrever a primeira.
- CPF e CNPJ validados no servidor; dados pessoais, salários e documentos de colaboradores só são
  enviados a quem tem acesso ao módulo Pessoas.
- Arquivos: só formatos permitidos, servidos com `nosniff`, CSP restritiva e checagem de permissão;
  são apagados junto com o cadastro.

## Automação de e-mails, Drive e IA

Lê `financeiro@` e `influenciadores@`, classifica anexos com o Claude, salva no Drive (`Financeiro|Influenciadores / Fornecedores|Clientes|Influenciadores / <nome> / <tipo> / <AAAA-MM>`), anexa ao cadastro e mostra na **Caixa de e-mails**. A leitura roda ao abrir o ERP (no máximo a cada 10 min), pelo botão "Ler e-mails agora" e pelo cron diário da Vercel, que também envia os lembretes de cobrança (liga/desliga em Configurações). O consumo de tokens fica em **Aprovações e configurações → Custos de APIs**.

Variáveis: `GOOGLE_SERVICE_ACCOUNT` (JSON da conta de serviço com delegação em todo o domínio), `DRIVE_PASTA_RAIZ`, `ANTHROPIC_API_KEY`, `CRON_SECRET`; opcionais `CAIXAS_EMAIL`, `DRIVE_USUARIO`, `EMAIL_REMETENTE`.

## Arquivos, backup, alertas e relatórios

- **Arquivos:** com o Drive configurado, documentos vão para `Arquivos do ERP/<cadastro>/<nome>` e o banco guarda só a referência (logos e fotos continuam no banco). Em Configurações há o botão para mover os documentos antigos.
- **Backup:** diário às 8h para `Backups do ERP` no Drive, e download manual em Configurações (administradores).
- **Notificações:** sino no app + aviso do navegador (sem configuração) e, opcionalmente, WhatsApp Cloud API (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_PARA`, opcional `WHATSAPP_TEMPLATE`). Liga/desliga em Configurações.
- **Limite de IA:** teto mensal em US$ em Configurações; ao atingir, a leitura automática pausa e avisa.
- **Relatórios:** DRE gerencial, orçado × realizado, rentabilidade por cliente. **Mídia e repasses** fica em Financeiro.
