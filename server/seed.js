// Dados de exemplo usados na primeira inicialização (ou em "Restaurar dados de exemplo").
const TODAY = new Date().toISOString().slice(0, 10);
const addMonths = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };
const m = (n, day = 10) => addMonths(TODAY.slice(0, 8) + String(day).padStart(2, "0"), n);

module.exports = () => ({
  usuarios: [
    { id: "u1", nome: "Carol Colicigno", email: "carol@mantra.ag", perfil: "admin", ativo: true, colaborador: "Carol Colicigno" },
    { id: "u2", nome: "Rafael Lima", email: "rafael@mantra.ag", perfil: "financeiro" },
    { id: "u3", nome: "Bia Santos", email: "bia@mantra.ag", perfil: "gestor" },
    { id: "u4", nome: "Leo Prado", email: "leo@mantra.ag", perfil: "colaborador" },
  ],
  clientes: [
    { id: "c1", nome: "Cliente Exemplo A", cnpj: "11.111.111/0001-91", contato: "marketing@cliente-a.com.br", contatoNome: "Juliana Reis", segmento: "Cosméticos", cidade: "São Paulo", uf: "SP", links: "Pasta do cliente | https://drive.google.com/drive/folders/exemplo-cliente-a" },
    { id: "c2", nome: "Cliente Exemplo B", cnpj: "22.222.222/0001-91", contato: "marca@cliente-b.com.br", contatoNome: "Marcos Lima", segmento: "Telecom", cidade: "São Paulo", uf: "SP" },
    { id: "c3", nome: "Cliente Exemplo C", cnpj: "33.333.333/0001-91", contato: "mkt@cliente-c.com.br", contatoNome: "Paula Souza", segmento: "Moda", cidade: "São Paulo", uf: "SP" },
    { id: "c4", nome: "Cliente Exemplo D", cnpj: "44.444.444/0001-91", contato: "marca@cliente-d.com.br", contatoNome: "Rodrigo Alves", segmento: "Financeiro", cidade: "São Paulo", uf: "SP" },
  ],
  fornecedores: [
    { id: "f1", nome: "Produtora Exemplo", cnpj: "55.555.555/0001-91", contato: "contato@produtora-exemplo.com.br", categoria: "Produção" },
    { id: "f2", nome: "Veículo Exemplo (mídia digital)", cnpj: "66.666.666/0001-91", contato: "midia@veiculo-exemplo.com.br", categoria: "Mídia" },
    { id: "f3", nome: "Software Exemplo", cnpj: "77.777.777/0001-91", contato: "contato@software-exemplo.com.br", categoria: "Software" },
  ],
  contas: [
    { id: "md2r", tipo: "receber", descricao: "Mídia Veículo Exemplo (mídia digital) — Projeto Exemplo Lançamento", parceiro: "Cliente Exemplo B", categoria: "Mídia", valor: 80000, vencimento: m(-1, 15), status: "pago", conciliado: true, aprovado: true },
    { id: "a1", tipo: "receber", descricao: "Fee mensal Cliente Exemplo A", parceiro: "Cliente Exemplo A", categoria: "Fee", valor: 45000, vencimento: m(-2), status: "pago", conciliado: true, aprovado: true },
    { id: "a2", tipo: "receber", descricao: "Fee mensal Cliente Exemplo A", parceiro: "Cliente Exemplo A", categoria: "Fee", valor: 45000, vencimento: m(-1), status: "pago", conciliado: true, aprovado: true },
    { id: `rec-k1-${m(0, 5).slice(0, 7)}`, contrato: "k1", tipo: "receber", descricao: "Parcela contrato — Fee de conta — branding e social", parceiro: "Cliente Exemplo A", categoria: "Fee", valor: 45000, vencimento: m(0, 5), status: "aberto", conciliado: false, aprovado: true },
    { id: "a4", tipo: "receber", descricao: "Projeto Exemplo Campanha", parceiro: "Cliente Exemplo C", categoria: "Projeto", valor: 82000, vencimento: m(-1, 20), status: "aberto", conciliado: false, aprovado: true },
    { id: `rec-k2-${m(0, 25).slice(0, 7)}`, contrato: "k2", tipo: "receber", descricao: "Parcela contrato — Fee de conta — performance", parceiro: "Cliente Exemplo B", categoria: "Fee", valor: 38000, vencimento: m(0, 25), status: "aberto", conciliado: false, aprovado: true },
    { id: "a6", tipo: "receber", descricao: "Fee mensal Cliente Exemplo B", parceiro: "Cliente Exemplo B", categoria: "Fee", valor: 38000, vencimento: m(-1, 25), status: "pago", conciliado: false, aprovado: true },
    { id: "a7", tipo: "receber", descricao: "Lançamento cartão", parceiro: "Cliente Exemplo D", categoria: "Projeto", valor: 120000, vencimento: m(1, 15), status: "aberto", conciliado: false, aprovado: true },
    { id: "a15", tipo: "receber", descricao: "Projeto Exemplo Campanha — 1ª parcela", parceiro: "Cliente Exemplo C", categoria: "Projeto", valor: 82000, vencimento: m(-2, 20), status: "pago", conciliado: true, aprovado: true },
    { id: "a16", tipo: "receber", descricao: "Fee mensal Cliente Exemplo B", parceiro: "Cliente Exemplo B", categoria: "Fee", valor: 38000, vencimento: m(-2, 25), status: "pago", conciliado: true, aprovado: true },
    { id: "a17", tipo: "receber", descricao: "Lançamento cartão — sinal", parceiro: "Cliente Exemplo D", categoria: "Projeto", valor: 60000, vencimento: m(-1, 8), status: "pago", conciliado: false, aprovado: true },
    { id: "a8", tipo: "pagar", descricao: "Produção filme Projeto Exemplo Campanha", parceiro: "Produtora Exemplo", categoria: "Produção", valor: 54000, vencimento: m(0, 18), status: "aberto", conciliado: false, aprovado: false },
    { id: "a9", tipo: "pagar", descricao: "Mídia paga Cliente Exemplo B", parceiro: "Veículo Exemplo (mídia digital)", categoria: "Mídia", valor: 22000, vencimento: m(-1, 28), status: "pago", conciliado: true, aprovado: true },
    { id: "a10", tipo: "pagar", descricao: "Licenças de software", parceiro: "Software Exemplo", categoria: "Software", valor: 4800, vencimento: m(0, 2), status: "aberto", conciliado: false, aprovado: true },
    { id: "a11", tipo: "pagar", descricao: "Aluguel escritório", parceiro: "Imobiliária Paulista", categoria: "Estrutura", valor: 18000, vencimento: m(-1, 5), status: "pago", conciliado: true, aprovado: true },
    { id: "a12", tipo: "pagar", descricao: "Aluguel escritório", parceiro: "Imobiliária Paulista", categoria: "Estrutura", valor: 18000, vencimento: m(0, 5), status: "pago", conciliado: false, aprovado: true },
    { id: "a13", tipo: "pagar", descricao: "Folha de pagamento", parceiro: "Colaboradores", categoria: "Pessoal", valor: 96000, vencimento: m(-1, 5), status: "pago", conciliado: true, aprovado: true },
    { id: "a14", tipo: "pagar", descricao: "Folha de pagamento", parceiro: "Colaboradores", categoria: "Pessoal", valor: 96000, vencimento: m(0, 5), status: "pago", conciliado: true, aprovado: true },
  ],
  notas: [
    { id: "n1", numero: "000231", cliente: "Cliente Exemplo A", valor: 45000, emissao: m(-2, 1), status: "emitida", contabilidade: true },
    { id: "n2", numero: "000232", cliente: "Cliente Exemplo A", valor: 45000, emissao: m(-1, 1), status: "emitida", contabilidade: true },
    { id: "n3", numero: "000233", cliente: "Cliente Exemplo B", valor: 38000, emissao: m(-1, 10), status: "emitida", contabilidade: false },
    { id: "n4", numero: "000234", cliente: "Cliente Exemplo C", valor: 82000, emissao: m(-1, 12), status: "emitida", contabilidade: false },
  ],
  compras: [
    { id: "p1", item: "Banco de imagens (anual)", fornecedor: "Software Exemplo", solicitante: "Bia Santos", valor: 6200, status: "cotação", cotacoesLista: [{ fornecedor: "Software Exemplo", valor: 6200, prazo: 1, obs: "Licença anual" }, { fornecedor: "Shutterstock", valor: 5400, prazo: 1, obs: "Pacote 750 imagens" }, { fornecedor: "Getty Images", valor: 7900, prazo: 2, obs: "" }] },
    { id: "p2", item: "Notebooks para direção de arte (2x)", fornecedor: "", solicitante: "Leo Prado", valor: 28000, status: "solicitado", cotacoesLista: [] },
    { id: "p3", item: "Captação drone Projeto Exemplo Campanha", fornecedor: "Produtora Exemplo", solicitante: "Bia Santos", valor: 9500, status: "aprovado", cotacoesLista: [{ fornecedor: "Produtora Exemplo", valor: 9500, prazo: 7, obs: "", escolhida: true }, { fornecedor: "Voa Drones", valor: 11200, prazo: 5, obs: "" }] },
  ],
  propostas: [
    { id: "v1", cliente: "Cliente Exemplo D", titulo: "Lançamento cartão Ultravioleta", valor: 120000, data: m(-1, 3), status: "pedido" },
    { id: "v2", cliente: "Cliente Exemplo C", titulo: "Campanha Inverno", valor: 95000, data: m(0, 2), status: "enviada" },
    { id: "v3", cliente: "Cliente Exemplo B", titulo: "Ativação festival", valor: 64000, data: m(0, 6), status: "rascunho" },
    { id: "v4", cliente: "Cliente Exemplo A", titulo: "Social always-on 2027", valor: 300000, data: m(-1, 20), status: "aprovada" },
  ],
  contratos: [
    { id: "k1", cliente: "Cliente Exemplo A", objeto: "Fee de conta — branding e social", diaVencimento: 5, valorMensal: 45000, inicio: m(-9, 1), fim: m(3, 1), reajuste: 4.5, indice: "IPCA" },
    { id: "k2", cliente: "Cliente Exemplo B", objeto: "Fee de conta — performance", diaVencimento: 25, valorMensal: 38000, inicio: m(-14, 1), fim: m(10, 1), reajuste: 5, indice: "IGP-M" },
    { id: "k3", cliente: "Cliente Exemplo C", objeto: "Projeto Projeto Exemplo Campanha", valorMensal: 41000, inicio: m(-4, 1), fim: m(-1, 1), reajuste: 0, indice: "—" },
  ],
  projetos: [
    { id: "j1", nome: "Projeto Exemplo WebApp", cliente: "Cliente Exemplo A", tipo: "WebApp", status: "ativo", orcamento: 180000, custoTerceiros: 32000, horas: 640, valorHora: 140 },
    { id: "j2", nome: "Projeto Exemplo Campanha", cliente: "Cliente Exemplo C", tipo: "Campanha", status: "ativo", orcamento: 164000, custoTerceiros: 63500, horas: 520, valorHora: 140 },
    { id: "j3", nome: "Projeto Exemplo Conteúdo", cliente: "Cliente Exemplo B", tipo: "Conteúdo", status: "pausado", orcamento: 114000, custoTerceiros: 22000, horas: 410, valorHora: 140 },
    { id: "j4", nome: "Projeto Exemplo Lançamento B", cliente: "Cliente Exemplo D", tipo: "Campanha", status: "ativo", orcamento: 120000, custoTerceiros: 15000, horas: 180, valorHora: 140 },
  ],
  atividades: [
    { id: "f1", cliente: "Cliente Exemplo C", proposta: "Campanha Inverno", tipo: "Reunião", data: m(0, 8), responsavel: "Bia Santos", descricao: "Apresentar ajustes da proposta", concluida: false },
    { id: "f2", cliente: "Cliente Exemplo B", proposta: "Ativação festival", tipo: "E-mail", data: m(0, 14), responsavel: "Bia Santos", descricao: "Enviar proposta revisada", concluida: false },
    { id: "f3", cliente: "Cliente Exemplo A", proposta: "Social always-on 2027", tipo: "Ligação", data: m(0, 20), responsavel: "Carol Colicigno", descricao: "Alinhar início do contrato", concluida: false },
    { id: "f4", cliente: "Cliente Exemplo D", proposta: "Lançamento cartão Ultravioleta", tipo: "WhatsApp", data: m(-1, 28), responsavel: "Bia Santos", descricao: "Confirmar aprovação do pedido", concluida: true },
  ],
  extrato: [],
  midias: [
    { id: "md1", cliente: "Cliente Exemplo A", veiculo: "Veículo Exemplo (mídia digital)", campanha: "Projeto Exemplo Natal — Instagram e Facebook", competencia: m(0, 1), valorBruto: 120000, comissao: 20, bv: 0, vencimentoCliente: m(0, 15), vencimentoVeiculo: m(0, 25), status: "veiculado" },
    { id: "md2", cliente: "Cliente Exemplo B", veiculo: "Veículo Exemplo (mídia digital)", campanha: "Projeto Exemplo Lançamento", competencia: m(-1, 1), valorBruto: 80000, comissao: 15, bv: 5, vencimentoCliente: m(-1, 15), vencimentoVeiculo: m(0, 5), status: "faturado", contaReceberId: "md2r" },
  ],
  orcamentos: [
    { id: "o1", ano: Number(TODAY.slice(0, 4)), tipo: "receita", categoria: "Fee", mensal: 110000 },
    { id: "o2", ano: Number(TODAY.slice(0, 4)), tipo: "receita", categoria: "Projeto", mensal: 40000 },
    { id: "o3", ano: Number(TODAY.slice(0, 4)), tipo: "despesa", categoria: "Produção", mensal: 30000 },
    { id: "o4", ano: Number(TODAY.slice(0, 4)), tipo: "despesa", categoria: "Software", mensal: 4500 },
    { id: "o5", ano: Number(TODAY.slice(0, 4)), tipo: "despesa", categoria: "Estrutura", mensal: 15000 },
  ],
  influenciadores: [
    { id: "i1", nome: "Duda Martins", arroba: "@dudamartins", rede: "Instagram", seguidores: 820000, nicho: "Beleza", email: "contato@dudamartins.com", cpfCnpj: "88.888.888/0001-91", pix: "contato@dudamartins.com", agencia: "Squad Talentos" },
    { id: "i2", nome: "Gui Ferraz", arroba: "@guiferraz", rede: "TikTok", seguidores: 1350000, nicho: "Humor", email: "gui@ferraz.art", pix: "gui@ferraz.art" },
  ],
  influContratos: [
    { id: "ic1", influenciador: "Duda Martins", cliente: "Cliente Exemplo A", campanha: "Projeto Exemplo Natal", entregaveis: "2 reels + 4 stories", valor: 18000, dataPublicacao: m(0, 5), vencimentoPagamento: m(0, 20), status: "publicado", nfRecebida: false },
    { id: "ic2", influenciador: "Gui Ferraz", cliente: "Cliente Exemplo B", campanha: "Projeto Exemplo Lançamento", entregaveis: "3 TikToks", valor: 26000, dataPublicacao: m(0, 18), vencimentoPagamento: m(1, 5), status: "assinado", nfRecebida: false },
  ],
  emails: [
    { id: "ex-1", exemplo: true, caixa: "financeiro@agenciamantra.com.br", area: "financeiro", de: "Produtora Exemplo <contato@produtora-exemplo.com.br>", assunto: "NF 1234 — filme conceito", data: m(0, 2) + "T13:20:00.000Z", tipo: "nota_fiscal", direcao: "a_pagar", resumo: "NFS-e da Produtora Exemplo referente ao filme conceito.", emitente: "Produtora Exemplo", numero: "1234", valor: 12500, vencimento: m(0, 25), entidade: { col: "fornecedores", id: "f1", nome: "Produtora Exemplo" }, status: "novo", anexos: [{ nome: "NFSe-1234.pdf", tipo: "application/pdf" }] },
    { id: "ex-2", exemplo: true, caixa: "influenciadores@agenciamantra.com.br", area: "influenciadores", de: "Duda Martins <contato@dudamartins.com>", assunto: "Nota fiscal campanha Natal", data: m(0, 3) + "T18:02:00.000Z", tipo: "nota_fiscal", direcao: "a_pagar", resumo: "NF da influenciadora Duda Martins pela campanha Projeto Exemplo Natal.", emitente: "Duda Martins", numero: "88", valor: 18000, vencimento: m(0, 20), influenciador: "@dudamartins", campanha: "Projeto Exemplo Natal", entidade: { col: "influenciadores", id: "i1", nome: "Duda Martins" }, status: "novo", anexos: [{ nome: "nf-88.pdf", tipo: "application/pdf" }] },
    { id: "ex-3", exemplo: true, caixa: "financeiro@agenciamantra.com.br", area: "financeiro", de: "juridico@cliente-b.com.br", assunto: "Aditivo contratual assinado", data: m(0, 1) + "T10:00:00.000Z", tipo: "contrato", direcao: "informativo", resumo: "Aditivo do contrato Cliente Exemplo B assinado digitalmente.", emitente: "Cliente Exemplo B", valor: 0, entidade: { col: "clientes", id: "c2", nome: "Cliente Exemplo B" }, status: "novo", anexos: [{ nome: "aditivo-vivo.pdf", tipo: "application/pdf" }] },
  ],
  notificacoes: [
    { id: "n-ex1", exemplo: true, data: m(0, 3) + "T18:05:00.000Z", titulo: "📥 1 documento(s) novo(s) em influenciadores@", texto: "   • Notas fiscais — Duda Martins — R$ 18.000,00", area: "influenciadores", modulo: "emails" },
    { id: "n-ex2", exemplo: true, data: m(0, 2) + "T13:25:00.000Z", titulo: "📥 1 documento(s) novo(s) em financeiro@", texto: "   • Notas fiscais — Produtora Exemplo — R$ 12.500,00", area: "financeiro", modulo: "emails" },
  ],
  consumo: [
    { id: "ia-ex1", exemplo: true, data: m(0, 2) + "T13:21:00.000Z", api: "Anthropic (Claude)", operacao: "Classificar e-mail", ref: "NF 1234 — filme conceito", modelo: "claude-opus-5-5", entrada: 3850, saida: 310, cacheLeitura: 0, cacheEscrita: 0, custoUsd: 0.0216 },
    { id: "ia-ex2", exemplo: true, data: m(0, 3) + "T18:03:00.000Z", api: "Anthropic (Claude)", operacao: "Classificar e-mail", ref: "Nota fiscal campanha Natal", modelo: "claude-opus-5-5", entrada: 2900, saida: 280, cacheLeitura: 0, cacheEscrita: 0, custoUsd: 0.0172 },
  ],
  concorrencias: [
    { id: "cc1", nome: "Concorrência Prospect Exemplo 1 — conta digital", cliente: "Prospect Exemplo 1", status: "apresentada", responsavel: "Bia Santos", dataApresentacao: m(0, 3), valorEstimado: 960000,
      links: "Pasta da concorrência | https://drive.google.com/drive/folders/exemplo", custos: [
        { descricao: "Horas de criação (equipe)", categoria: "Criação / horas internas", valor: 18000, data: m(-1, 20), fornecedor: "" },
        { descricao: "Filme conceito", categoria: "Produção", valor: 12500, data: m(-1, 26), fornecedor: "Produtora Exemplo" },
        { descricao: "Pesquisa qualitativa", categoria: "Pesquisa", valor: 6800, data: m(-1, 15), fornecedor: "" }] },
    { id: "cc2", nome: "Pitch Prospect Exemplo 2 — lançamento", cliente: "Prospect Exemplo 2", status: "ganha", responsavel: "Carol Colicigno", dataApresentacao: m(-2, 12), valorEstimado: 420000, custos: [
        { descricao: "Horas de criação (equipe)", categoria: "Criação / horas internas", valor: 9000, data: m(-2, 5), fornecedor: "" },
        { descricao: "Mockups impressos", categoria: "Impressão / materiais", valor: 1800, data: m(-2, 10), fornecedor: "" }] },
    { id: "cc3", nome: "Concorrência Prospect Exemplo 3", cliente: "Prospect Exemplo 3", status: "perdida", responsavel: "Bia Santos", dataApresentacao: m(-3, 22), valorEstimado: 600000, custos: [
        { descricao: "Horas de criação (equipe)", categoria: "Criação / horas internas", valor: 14000, data: m(-3, 10), fornecedor: "" }] },
  ],
  tarefas: [
    { id: "t1", projetoId: "j1", col: "todo", etiquetas: "UX Design, UX Research", titulo: "Processo de UX completo da primeira versão", responsavel: "Leo Prado", comentarios: 12, anexos: 4, prazo: m(0, 13) },
    { id: "t2", projetoId: "j1", col: "todo", etiquetas: "Wireframe", titulo: "Wireframes das telas principais", responsavel: "Ana Kim", comentarios: 5, anexos: 2, prazo: m(0, 17) },
    { id: "t3", projetoId: "j1", col: "todo", etiquetas: "UI Design", titulo: "Design de interface do produto", responsavel: "Leo Prado", comentarios: 3, anexos: 1, prazo: m(0, 24) },
    { id: "t4", projetoId: "j1", col: "progress", etiquetas: "Levantamento", titulo: "Coletar todos os detalhes do cliente", responsavel: "Bia Santos", comentarios: 12, anexos: 4, prazo: m(0, 8) },
    { id: "t5", projetoId: "j1", col: "progress", etiquetas: "Business Insights", titulo: "Insights de negócio com o cliente", responsavel: "Bia Santos", comentarios: 8, anexos: 3, prazo: m(0, 15) },
    { id: "t6", projetoId: "j1", col: "review", etiquetas: "Planejamento", titulo: "Planejamento do projeto concluído", responsavel: "Bia Santos", comentarios: 12, anexos: 4, prazo: "" },
    { id: "t7", projetoId: "j1", col: "review", etiquetas: "Website", titulo: "Segundo conceito de design", responsavel: "Leo Prado", comentarios: 6, anexos: 4, prazo: m(0, 12) },
    { id: "t8", projetoId: "j1", col: "done", etiquetas: "Levantamento", titulo: "Kickoff com o cliente", responsavel: "Carol Colicigno", comentarios: 4, anexos: 1, prazo: "" },
    { id: "t9", projetoId: "j2", col: "progress", etiquetas: "Produção", titulo: "Filmagem Projeto Exemplo Campanha", responsavel: "Bia Santos", comentarios: 9, anexos: 6, prazo: m(0, 14) },
    { id: "t10", projetoId: "j2", col: "review", etiquetas: "Redação", titulo: "Roteiro do filme de 30s", responsavel: "Ana Kim", comentarios: 15, anexos: 2, prazo: m(0, 11) },
    { id: "t11", projetoId: "j2", col: "done", etiquetas: "Mídia", titulo: "Plano de mídia aprovado", responsavel: "Tiago Reis", comentarios: 6, anexos: 3, prazo: "" },
    { id: "t12", projetoId: "j3", col: "todo", etiquetas: "Mídia", titulo: "Otimizar campanhas de performance", responsavel: "Tiago Reis", comentarios: 2, anexos: 0, prazo: m(0, 20) },
    { id: "t13", projetoId: "j4", col: "todo", etiquetas: "Conceito", titulo: "Conceito criativo do lançamento", responsavel: "Ana Kim", comentarios: 1, anexos: 0, prazo: m(0, 16) },
    { id: "t14", projetoId: "j4", col: "progress", etiquetas: "UI Design", titulo: "Key visual do cartão", responsavel: "Leo Prado", comentarios: 4, anexos: 2, prazo: m(0, 13) },
  ],
  colaboradores: [
    { id: "e1", nome: "Carol Colicigno", cargo: "Diretora", area: "Diretoria", vinculo: "PJ", salario: 28000, beneficios: 3200, admissao: "2019-02-01" },
    { id: "e2", nome: "Bia Santos", cargo: "Gerente de projetos", area: "Atendimento", salario: 14000, beneficios: 2100, admissao: "2021-05-10" },
    { id: "e3", nome: "Leo Prado", cargo: "Diretor de arte", area: "Criação", salario: 11000, beneficios: 1900, admissao: "2022-08-01" },
    { id: "e4", nome: "Rafael Lima", cargo: "Analista financeiro", area: "Financeiro", salario: 9000, beneficios: 1700, admissao: "2023-01-16" },
    { id: "e5", nome: "Ana Kim", cargo: "Redatora", area: "Criação", salario: 8500, beneficios: 1700, admissao: "2023-09-04" },
    { id: "e6", nome: "Tiago Reis", cargo: "Analista de mídia", area: "Mídia", salario: 9500, beneficios: 1700, admissao: "2024-03-11" },
  ],
});
