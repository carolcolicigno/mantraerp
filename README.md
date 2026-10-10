# Mantra ERP

Sistema de gestão da agência Mantra: financeiro, faturamento e fiscal, compras e fornecedores,
vendas e clientes, contratos, projetos e serviços, pessoas, relatórios gerenciais e aprovações e acessos.

Não há dependências para instalar: o servidor usa só o Node.js (≥ 22.5), com banco SQLite embutido.

## Rodar localmente

```bash
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
| `DB_PATH` | `data/mantra.db` | Arquivo do banco SQLite |
| `SEED_PASSWORD` | aleatória | Senha inicial dos usuários de exemplo (só na criação do banco) |
| `COOKIE_SECURE` | — | Use `1` em produção com HTTPS |

## Publicar

Qualquer serviço que rode Node com disco persistente serve (Railway, Render, Fly.io, uma VM).
Com Docker:

```bash
docker build -t mantra-erp .
docker run -p 3000:3000 -v mantra-data:/data -e COOKIE_SECURE=1 mantra-erp
```

Faça backup do arquivo do banco (`/data/mantra.db`) regularmente.

## Segurança

- Senhas guardadas com scrypt + salt; sessões em cookie `HttpOnly` / `SameSite=Strict`.
- Permissões por perfil verificadas no servidor (não só na tela), inclusive quem pode aprovar
  despesas e compras; salários só são enviados a quem tem acesso ao módulo Pessoas.
- Limite de 10 tentativas de login a cada 15 minutos por IP.
- Toda alteração fica registrada no histórico com o usuário autenticado.
