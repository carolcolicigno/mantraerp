/* Mantra ERP — módulos de gestão da agência.
   Os dados vêm da API (server/server.js); alterações são sincronizadas automaticamente. */

const TODAY = new Date().toISOString().slice(0, 10);

const BRL = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDate = (d) => (d ? d.split("-").reverse().join("/") : "—");
const uid = () => Math.random().toString(36).slice(2, 9);
const addMonths = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };
const monthKey = (iso) => iso.slice(0, 7);
const monthLabel = (key) => new Date(key + "-15T12:00:00").toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const escH = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* ---------- Comunicação com o servidor ---------- */
const SYNC_COLS = ["contas", "notas", "compras", "fornecedores", "clientes", "propostas", "contratos", "projetos", "colaboradores", "usuarios", "config", "tarefas", "extrato", "atividades", "concorrencias", "influenciadores", "influContratos", "emails", "midias", "orcamentos"];
let db = null;
let me = null;
let synced = {};
let pendingLog = null;
let syncChain = Promise.resolve();

async function apiFetch(url, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Mantra": "1" }, body: JSON.stringify(body) };
  const r = await fetch(url, { credentials: "same-origin", ...init });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== "/api/login") showLogin();
  if (!r.ok) throw new Error(j.erro || "Falha de comunicação com o servidor");
  return j;
}
function snapshot() {
  synced = Object.fromEntries(SYNC_COLS.map((c) => [c, new Map((db[c] || []).map((r) => [r.id, JSON.stringify(r)]))]));
}
async function loadData() { db = await apiFetch("/api/data"); snapshot(); }

// Compara o estado local com o último sincronizado e envia só o que mudou.
function save() {
  if (!db) return;
  const changes = [];
  for (const col of SYNC_COLS) {
    const prev = synced[col] || new Map();
    const cur = new Map();
    for (const r of db[col] || []) {
      let data = r;
      if (col === "usuarios" && r.senha) { data = { ...r }; delete r.senha; }
      const s = JSON.stringify(r);
      cur.set(r.id, s);
      if (prev.get(r.id) !== s || data !== r) changes.push({ op: "put", col, id: r.id, data });
    }
    for (const id of prev.keys()) if (!cur.has(id)) changes.push({ op: "delete", col, id });
    synced[col] = cur;
  }
  const lg = pendingLog; pendingLog = null;
  if (!changes.length && !lg) return;
  syncChain = syncChain
    .then(() => apiFetch("/api/sync", { changes, ...(lg || {}) }))
    .then((r) => {
      // Atualiza a versão (_rev) dos registros gravados, sem marcar como alterados.
      for (const { col, id, rev } of r.revs || []) {
        const rec = (db[col] || []).find((x) => x.id === id);
        if (!rec) continue;
        const emDia = synced[col].get(id) === JSON.stringify(rec);
        rec._rev = rev;
        if (emDia) synced[col].set(id, JSON.stringify(rec));
      }
      if (r.historico && hasHist()) { db.historico.unshift(r.historico); if (state2.tab.aprovacoes === "Histórico de alterações" && state2.mod === "aprovacoes") renderView(); } })
    .catch(async (e) => { toast(e.message); await loadData().catch(() => {}); renderView(); });
}
const asaasOn = () => !!db.integracoes?.asaas;
// Chama uma ação do servidor que devolve registros já gravados; aplica-os sem reenviar.
async function apiAction(url, body) {
  save(); await syncChain;
  const r = await apiFetch(url, body);
  for (const { col, rec } of r.registros || []) {
    const i = db[col].findIndex((x) => x.id === rec.id);
    if (i >= 0) db[col][i] = rec; else db[col].push(rec);
    synced[col].set(rec.id, JSON.stringify(rec));
  }
  if (r.historico && hasHist()) db.historico.unshift(r.historico);
  renderView();
  return r;
}
const hasHist = () => Array.isArray(db.historico) && can("aprovacoes");
const currentUser = () => me;
const cfg = () => db.config?.[0] || { id: "geral", regime: "Simples Nacional", aliquota: 11.33, encargos: 68 };
const encargo = () => 1 + (Number(cfg().encargos) || 0) / 100;
function log(acao, detalhe) { pendingLog = { acao, detalhe }; queueMicrotask(save); }
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}

/* ---------- Permissões ---------- */
const PERFIS = {
  admin: { label: "Administrador", modulos: "*", aprova: true },
  financeiro: { label: "Financeiro", modulos: ["overview", "financeiro", "faturamento", "compras", "contratos", "relatorios", "aprovacoes", "emails", "influenciadores"], aprova: true },
  gestor: { label: "Gestor", modulos: ["overview", "projetos", "servicos", "vendas", "contratos", "compras", "pessoas", "relatorios", "aprovacoes", "influenciadores", "emails"], aprova: true },
  colaborador: { label: "Colaborador", modulos: ["projetos", "servicos", "compras"], aprova: false },
};
const can = (mod) => mod === "usuarios" ? currentUser().perfil === "admin" : (currentUser().modulosEfetivos || []).includes(mod);
const canApprove = () => !!currentUser().podeAprovar;

/* ---------- Esquemas de cadastro ---------- */
const opts = (col, key = "nome") => () => db[col].map((x) => x[key]);
const SCHEMAS = {
  contas: { singular: "Lançamento", fields: [
    { k: "tipo", label: "Tipo", type: "select", options: ["receber", "pagar"] },
    { k: "descricao", label: "Descrição" },
    { k: "parceiro", label: "Cliente / Fornecedor" },
    { k: "categoria", label: "Categoria", type: "select", options: ["Fee", "Projeto", "Produção", "Mídia", "Software", "Estrutura", "Pessoal", "Impostos", "Concorrência", "Influenciadores", "Repasse de mídia", "BV", "Outros"] },
    { k: "valor", label: "Valor", type: "money" },
    { k: "vencimento", label: "Vencimento", type: "date" },
    { k: "status", label: "Status", type: "select", options: ["aberto", "pago"] },
  ] },
  notas: { singular: "Nota fiscal", fields: [
    { k: "numero", label: "Número" },
    { k: "cliente", label: "Cliente", type: "select", options: opts("clientes") },
    { k: "valor", label: "Valor", type: "money" },
    { k: "emissao", label: "Emissão", type: "date" },
    { k: "status", label: "Status", type: "select", options: ["emitida", "cancelada"] },
    { k: "contabilidade", label: "Enviada à contabilidade", type: "bool" },
  ] },
  compras: { singular: "Solicitação de compra", fields: [
    { k: "item", label: "Item / serviço", full: true },
    { k: "fornecedor", label: "Fornecedor", type: "select", options: () => ["", ...db.fornecedores.map((f) => f.nome)] },
    { k: "solicitante", label: "Solicitante", type: "select", options: opts("colaboradores") },
    { k: "valor", label: "Valor estimado", type: "money" },
    { k: "status", label: "Status", type: "select", options: ["solicitado", "cotação", "aprovado", "recusado"] },
  ] },
  fornecedores: { singular: "Fornecedor", wide: true, fields: [
    { section: "Identificação" },
    { k: "nome", label: "Nome" },
    { k: "categoria", label: "Categoria", type: "select", options: ["Produção", "Mídia", "Software", "Serviços", "Estrutura", "Outros"] },
    { k: "cnpj", label: "CNPJ ou CPF", type: "cnpj", optional: true },
    { k: "razaoSocial", label: "Razão social", optional: true },
    { section: "Contato e pagamento" },
    { k: "contato", label: "E-mail", type: "email", optional: true },
    { k: "telefone", label: "Telefone", type: "tel", optional: true },
    { k: "pix", label: "Chave Pix", optional: true },
    { k: "dadosBancarios", label: "Banco / agência / conta", optional: true },
    { section: "Endereço" },
    { k: "cep", label: "CEP", type: "cep", optional: true },
    { k: "logradouro", label: "Logradouro", optional: true },
    { k: "numero", label: "Número", optional: true },
    { k: "complemento", label: "Complemento", optional: true },
    { k: "bairro", label: "Bairro", optional: true },
    { k: "cidade", label: "Cidade", optional: true },
    { k: "uf", label: "UF", optional: true, maxlength: 2 },
    { section: "Links de pastas" },
    { k: "links", label: "Um por linha, no formato: Nome | https://link (Drive, Dropbox, OneDrive…)", type: "textarea", optional: true, full: true },
    { section: "Observações" },
    { k: "observacoes", label: "Observações", type: "textarea", optional: true, full: true },
  ] },
  clientes: { singular: "Cliente", wide: true, fields: [
    { section: "Identificação" },
    { k: "logoId", label: "Logo", type: "image", categoria: "logo", full: true },
    { k: "cnpj", label: "CNPJ", type: "cnpj", lookup: true },
    { k: "nome", label: "Nome fantasia" },
    { k: "razaoSocial", label: "Razão social", optional: true },
    { k: "segmento", label: "Segmento", optional: true },
    { k: "inscricaoEstadual", label: "Inscrição estadual", optional: true },
    { k: "inscricaoMunicipal", label: "Inscrição municipal", optional: true },
    { k: "site", label: "Site", optional: true },
    { section: "Contatos" },
    { k: "contatoNome", label: "Contato principal", optional: true },
    { k: "contato", label: "E-mail principal", type: "email", optional: true },
    { k: "telefone", label: "Telefone", type: "tel", optional: true },
    { k: "emailFinanceiro", label: "E-mail do financeiro (cobranças e NF)", type: "email", optional: true },
    { section: "Endereço" },
    { k: "cep", label: "CEP", type: "cep", optional: true },
    { k: "logradouro", label: "Logradouro", optional: true },
    { k: "numero", label: "Número", optional: true },
    { k: "complemento", label: "Complemento", optional: true },
    { k: "bairro", label: "Bairro", optional: true },
    { k: "cidade", label: "Cidade", optional: true },
    { k: "uf", label: "UF", optional: true, maxlength: 2 },
    { section: "Links de pastas" },
    { k: "links", label: "Um por linha, no formato: Nome | https://link (Drive, Dropbox, OneDrive…)", type: "textarea", optional: true, full: true },
    { section: "Observações" },
    { k: "observacoes", label: "Observações", type: "textarea", optional: true, full: true },
  ] },
  propostas: { singular: "Proposta", fields: [
    { k: "cliente", label: "Cliente", type: "select", options: opts("clientes") },
    { k: "titulo", label: "Título" },
    { k: "valor", label: "Valor", type: "money" },
    { k: "data", label: "Data", type: "date" },
    { k: "status", label: "Status", type: "select", options: ["rascunho", "enviada", "aprovada", "pedido", "perdida"] },
  ] },
  contratos: { singular: "Contrato", fields: [
    { k: "cliente", label: "Cliente", type: "select", options: opts("clientes") },
    { k: "objeto", label: "Objeto", full: true },
    { k: "valorMensal", label: "Parcela mensal", type: "money" },
    { k: "inicio", label: "Início da vigência", type: "date" },
    { k: "fim", label: "Fim da vigência", type: "date" },
    { k: "diaVencimento", label: "Dia de vencimento da parcela", type: "number" },
    { k: "reajuste", label: "Reajuste anual (%)", type: "number" },
    { k: "indice", label: "Índice", type: "select", options: ["IPCA", "IGP-M", "INPC", "—"] },
  ] },
  projetos: { singular: "Projeto", fields: [
    { k: "nome", label: "Projeto" },
    { k: "cliente", label: "Cliente", type: "select", options: opts("clientes") },
    { k: "tipo", label: "Tipo", type: "select", options: ["Campanha", "Conteúdo", "Website", "App", "WebApp"] },
    { k: "status", label: "Status", type: "select", options: ["ativo", "pausado", "encerrado"] },
    { k: "orcamento", label: "Orçamento vendido", type: "money" },
    { k: "custoTerceiros", label: "Custos de terceiros", type: "money" },
    { k: "horas", label: "Horas trabalhadas", type: "number" },
    { k: "valorHora", label: "Custo/hora interno", type: "money" },
  ] },
  colaboradores: { singular: "Colaborador", wide: true, fields: [
    { section: "Profissional" },
    { k: "fotoId", label: "Foto", type: "image", categoria: "foto", full: true },
    { k: "nome", label: "Nome completo" }, { k: "cargo", label: "Cargo" },
    { k: "area", label: "Área", type: "select", options: ["Diretoria", "Atendimento", "Criação", "Mídia", "Financeiro", "Tecnologia"] },
    { k: "vinculo", label: "Vínculo", type: "select", options: ["CLT", "PJ", "Estágio", "Freelancer"] },
    { k: "admissao", label: "Admissão", type: "date" },
    { k: "salario", label: "Salário / remuneração", type: "money" }, { k: "beneficios", label: "Benefícios", type: "money" },
    { section: "Dados pessoais" },
    { k: "cpf", label: "CPF", type: "cpf", optional: true },
    { k: "rg", label: "RG", optional: true },
    { k: "nascimento", label: "Data de nascimento", type: "date", optional: true },
    { k: "email", label: "E-mail pessoal", type: "email", optional: true },
    { k: "telefone", label: "Celular", type: "tel", optional: true },
    { section: "Endereço" },
    { k: "cep", label: "CEP", type: "cep", optional: true },
    { k: "logradouro", label: "Logradouro", optional: true },
    { k: "numero", label: "Número", optional: true },
    { k: "complemento", label: "Complemento", optional: true },
    { k: "bairro", label: "Bairro", optional: true },
    { k: "cidade", label: "Cidade", optional: true },
    { k: "uf", label: "UF", optional: true, maxlength: 2 },
    { section: "Contato de emergência" },
    { k: "emergenciaNome", label: "Nome", optional: true },
    { k: "emergenciaTelefone", label: "Telefone", type: "tel", optional: true },
    { section: "Dados bancários" },
    { k: "banco", label: "Banco", optional: true },
    { k: "agencia", label: "Agência", optional: true },
    { k: "contaBancaria", label: "Conta", optional: true },
    { k: "pix", label: "Chave Pix", optional: true },
    { section: "Links de pastas" },
    { k: "links", label: "Um por linha, no formato: Nome | https://link (Drive, Dropbox, OneDrive…)", type: "textarea", optional: true, full: true },
  ] },
  atividades: { singular: "Follow-up", fields: [
    { k: "cliente", label: "Cliente", type: "select", options: opts("clientes") },
    { k: "proposta", label: "Proposta", type: "select", options: () => ["", ...db.propostas.map((v) => v.titulo)] },
    { k: "tipo", label: "Tipo", type: "select", options: ["Ligação", "Reunião", "E-mail", "WhatsApp", "Visita"] },
    { k: "data", label: "Data", type: "date" },
    { k: "responsavel", label: "Responsável", type: "select", options: opts("colaboradores") },
    { k: "descricao", label: "O que fazer", full: true },
    { k: "concluida", label: "Concluído", type: "bool" },
  ] },
  tarefas: { singular: "Tarefa", fields: [
    { k: "titulo", label: "Tarefa", full: true },
    { k: "etiquetas", label: "Etiquetas (separadas por vírgula)", full: true, optional: true },
    { k: "col", label: "Status", type: "select", options: ["todo", "progress", "review", "done"], labels: { todo: "A fazer", progress: "Em andamento", review: "Em revisão", done: "Concluído" } },
    { k: "responsavel", label: "Responsável", type: "select", options: () => ["", ...db.colaboradores.map((c) => c.nome)] },
    { k: "prazo", label: "Prazo", type: "date", optional: true },
    { k: "comentarios", label: "Comentários", type: "number" },
    { k: "anexos", label: "Anexos", type: "number" },
  ] },
  usuarios: { singular: "Usuário", wide: true, fields: [
    { section: "Acesso" },
    { k: "nome", label: "Nome" }, { k: "email", label: "E-mail de login", type: "email" },
    { k: "senha", label: "Senha (mín. 8; em branco mantém a atual)", type: "password" },
    { k: "perfil", label: "Perfil", type: "select", options: () => Object.keys(PERFIS), labels: { admin: "Administrador", financeiro: "Financeiro", gestor: "Gestor", colaborador: "Colaborador" } },
    { k: "colaborador", label: "Colaborador vinculado", type: "select", options: () => ["", ...db.colaboradores.map((c) => c.nome)] },
    { k: "ativo", label: "Acesso ativo", type: "bool" },
    { section: "Permissões personalizadas (opcional)" },
    { k: "modulos", label: "Marque só se este usuário precisar de módulos diferentes do padrão do perfil. Administradores sempre veem tudo.", type: "checks", full: true, options: () => MODULOS_PERM, labels: () => Object.fromEntries(MODULOS_PERM.map((m) => [m, MODULES[m].label])) },
    { k: "aprovacao", label: "Pode aprovar despesas e compras?", type: "select", options: ["perfil", "sim", "nao"], labels: { perfil: "Padrão do perfil", sim: "Sim", nao: "Não" } },
  ] },
  influenciadores: { singular: "Influenciador", wide: true, fields: [
    { section: "Perfil" },
    { k: "fotoId", label: "Foto", type: "image", categoria: "foto", full: true },
    { k: "nome", label: "Nome" }, { k: "arroba", label: "@ principal" },
    { k: "rede", label: "Rede principal", type: "select", options: ["Instagram", "TikTok", "YouTube", "Kwai", "X / Twitter", "LinkedIn", "Twitch", "Outra"] },
    { k: "seguidores", label: "Seguidores", type: "number" },
    { k: "nicho", label: "Nicho", optional: true },
    { k: "agencia", label: "Agência / empresário", optional: true },
    { section: "Contato e pagamento" },
    { k: "email", label: "E-mail (o mesmo que manda NF e contratos)", type: "email", optional: true },
    { k: "telefone", label: "Telefone", type: "tel", optional: true },
    { k: "cpfCnpj", label: "CPF ou CNPJ (de quem emite a NF)", type: "cnpj", optional: true },
    { k: "pix", label: "Chave Pix", optional: true },
    { k: "dadosBancarios", label: "Banco / agência / conta", optional: true },
    { section: "Links de pastas" },
    { k: "links", label: "Um por linha, no formato: Nome | https://link (Drive, mídia kit…)", type: "textarea", optional: true, full: true },
    { section: "Observações" },
    { k: "observacoes", label: "Observações", type: "textarea", optional: true, full: true },
  ] },
  influContratos: { singular: "Contrato de influenciador", wide: true, fields: [
    { k: "influenciador", label: "Influenciador", type: "select", options: opts("influenciadores") },
    { k: "cliente", label: "Cliente", type: "select", options: opts("clientes") },
    { k: "campanha", label: "Campanha" },
    { k: "status", label: "Status", type: "select", options: ["negociação", "contrato enviado", "assinado", "publicado", "pago", "cancelado"] },
    { k: "entregaveis", label: "Entregáveis", type: "textarea", full: true },
    { k: "valor", label: "Cachê", type: "money" },
    { k: "dataPublicacao", label: "Data de publicação", type: "date", optional: true },
    { k: "vencimentoPagamento", label: "Vencimento do pagamento", type: "date", optional: true },
    { k: "nfRecebida", label: "NF recebida", type: "bool" },
    { k: "links", label: "Links (contrato, posts publicados) — Nome | https://link", type: "textarea", optional: true, full: true },
  ] },
  midias: { singular: "Veiculação de mídia", wide: true, fields: [
    { k: "cliente", label: "Cliente", type: "select", options: opts("clientes") },
    { k: "veiculo", label: "Veículo / plataforma (fornecedor)", type: "select", options: opts("fornecedores") },
    { k: "campanha", label: "Campanha / PI", full: true },
    { k: "competencia", label: "Mês de veiculação", type: "date" },
    { k: "valorBruto", label: "Valor bruto da mídia", type: "money" },
    { k: "comissao", label: "Comissão da agência (%)", type: "number" },
    { k: "bv", label: "BV do veículo (%)", type: "number" },
    { k: "vencimentoCliente", label: "Vencimento para o cliente", type: "date" },
    { k: "vencimentoVeiculo", label: "Vencimento do repasse ao veículo", type: "date" },
    { k: "status", label: "Status", type: "select", options: ["planejado", "veiculado", "faturado", "repassado", "cancelado"] },
  ] },
  orcamentos: { singular: "Linha de orçamento", fields: [
    { k: "ano", label: "Ano", type: "number" },
    { k: "tipo", label: "Tipo", type: "select", options: ["receita", "despesa"] },
    { k: "categoria", label: "Categoria", type: "select", options: () => SCHEMAS.contas.fields[3].options },
    { k: "mensal", label: "Valor orçado por mês", type: "money" },
    { k: "observacao", label: "Observação", optional: true, full: true },
  ] },
  concorrencias: { singular: "Concorrência", wide: true, fields: [
    { section: "Concorrência" },
    { k: "nome", label: "Nome da concorrência", full: true },
    { k: "cliente", label: "Cliente ou prospect" },
    { k: "status", label: "Status", type: "select", options: ["em preparação", "apresentada", "ganha", "perdida", "cancelada"] },
    { k: "responsavel", label: "Responsável", type: "select", options: () => ["", ...db.colaboradores.map((c) => c.nome)] },
    { k: "dataApresentacao", label: "Data de apresentação", type: "date", optional: true },
    { k: "valorEstimado", label: "Verba / valor estimado da conta (anual)", type: "money" },
    { section: "Links de pastas" },
    { k: "links", label: "Um por linha, no formato: Nome | https://link (Drive, Dropbox, OneDrive…)", type: "textarea", optional: true, full: true },
    { section: "Observações" },
    { k: "observacoes", label: "Observações", type: "textarea", optional: true, full: true },
  ] },
};

/* ---------- Formulário (modal) ---------- */
const dialog = document.getElementById("formDialog");
let formCtx = null;
const MASK = {
  cpf: (d) => d.slice(0, 11).replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2"),
  cnpj: (d) => d.length <= 11 ? MASK.cpf(d) : d.slice(0, 14).replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d)/, "$1-$2"),
  cep: (d) => d.slice(0, 8).replace(/(\d{5})(\d)/, "$1-$2"),
  tel: (d) => d.slice(0, 11).replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d)(\d{4})$/, "$1-$2"),
};
const fileUrl = (id) => `/api/arquivos/${encodeURIComponent(id)}`;
function openForm(col, record, defaults = {}) {
  const sc = SCHEMAS[col];
  const rec = record || { ...defaults };
  formCtx = { col, id: record?.id, defaults, images: {} };
  dialog.classList.toggle("dialog--wide", !!sc.wide);
  document.getElementById("formDelete").hidden = !record;
  document.getElementById("formTitle").textContent = (record ? "Editar " : "Novo ") + sc.singular.toLowerCase();
  document.getElementById("formFields").innerHTML = sc.fields.map((f) => {
    if (f.section) return `<h3 class="form-section">${f.section}</h3>`;
    const v = rec[f.k] ?? "";
    let input;
    if (f.type === "select") {
      const o = typeof f.options === "function" ? f.options() : f.options;
      input = `<select name="${f.k}">${o.map((x) => `<option value="${escH(x)}" ${x === v ? "selected" : ""}>${escH(f.labels?.[x] ?? x)}</option>`).join("")}</select>`;
    } else if (f.type === "bool") {
      const marcado = f.k === "ativo" && !record ? true : v;
      input = `<input type="checkbox" name="${f.k}" ${marcado ? "checked" : ""} />`;
    } else if (f.type === "checks") {
      const o = typeof f.options === "function" ? f.options() : f.options;
      const lb = typeof f.labels === "function" ? f.labels() : f.labels || {};
      const sel = Array.isArray(v) ? v : [];
      return `<fieldset class="checks full"><legend>${f.label}</legend>${o.map((x) => `<label class="check"><input type="checkbox" name="${f.k}" value="${escH(x)}" ${sel.includes(x) ? "checked" : ""} />${escH(lb[x] ?? x)}</label>`).join("")}</fieldset>`;
    } else if (f.type === "image") {
      return `<div class="img-field full"><img id="img-${f.k}" src="${v ? fileUrl(v) : "logo.svg"}" class="${v ? "" : "is-empty"}" alt="" />
        <label class="btn-ghost">Escolher imagem<input type="file" accept="image/png,image/jpeg,image/webp" data-image="${f.k}" hidden /></label>
        ${v ? `<button type="button" class="btn-ghost no" data-image-clear="${f.k}">Remover</button>` : ""}<span class="crumbs">${f.label} · PNG, JPG ou WEBP</span></div>`;
    } else if (f.type === "textarea") {
      input = `<textarea name="${f.k}" rows="3" ${f.optional ? "" : "required"}>${escH(v)}</textarea>`;
    } else {
      const t = f.type === "date" ? "date" : f.type === "money" || f.type === "number" ? "number" : f.type === "password" ? "password" : f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text";
      const req = f.type === "password" ? (record ? "" : "required") : f.optional ? "" : "required";
      const extra = MASK[f.type] ? `data-mask="${f.type}" inputmode="numeric"` : "";
      input = `<input type="${t}" name="${f.k}" value="${t === "password" ? "" : escH(v)}" ${t === "number" ? 'step="any"' : ""} ${t === "password" ? 'minlength="8" autocomplete="new-password"' : ""} ${f.maxlength ? `maxlength="${f.maxlength}"` : ""} ${extra} ${req} />`;
      if (f.lookup) input = `<span class="input-btn">${input}<button type="button" class="btn-ghost" data-cnpj-lookup>Buscar dados</button></span>`;
      if (f.type === "cep") input = `<span class="input-btn">${input}<button type="button" class="btn-ghost" data-cep-lookup>Buscar CEP</button></span>`;
    }
    return `<label class="${f.full ? "full" : ""}">${f.label}${input}</label>`;
  }).join("");
  dialog.showModal();
}
const fieldEl = (k) => document.querySelector(`#recordForm [name="${k}"]`);
const preencher = (map) => { for (const [k, v] of Object.entries(map)) { const el = fieldEl(k); if (el && v && !el.value) el.value = v; } };
document.getElementById("formFields").addEventListener("input", (e) => {
  const m = e.target.dataset.mask;
  if (m) e.target.value = MASK[m](e.target.value.replace(/\D/g, ""));
});
document.getElementById("formFields").addEventListener("change", (e) => {
  const k = e.target.dataset.image;
  if (!k || !e.target.files[0]) return;
  formCtx.images[k] = e.target.files[0];
  const img = document.getElementById(`img-${k}`);
  img.src = URL.createObjectURL(e.target.files[0]); img.classList.remove("is-empty");
});
document.getElementById("formFields").addEventListener("click", async (e) => {
  const clear = e.target.closest("[data-image-clear]");
  if (clear) { formCtx.images[clear.dataset.imageClear] = null; const img = document.getElementById(`img-${clear.dataset.imageClear}`); img.src = "logo.svg"; img.classList.add("is-empty"); clear.remove(); return; }
  if (e.target.closest("[data-cep-lookup]")) {
    const cep = (fieldEl("cep")?.value || "").replace(/\D/g, "");
    if (cep.length !== 8) return toast("Digite um CEP com 8 dígitos");
    try {
      const r = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
      if (r.erro) return toast("CEP não encontrado");
      ["logradouro", "bairro", "cidade", "uf"].forEach((k) => { const el = fieldEl(k); if (el) el.value = ""; });
      preencher({ logradouro: r.logradouro, bairro: r.bairro, cidade: r.localidade, uf: r.uf });
      fieldEl("numero")?.focus();
    } catch { toast("Não foi possível consultar o CEP agora"); }
  }
  if (e.target.closest("[data-cnpj-lookup]")) {
    const cnpj = (fieldEl("cnpj")?.value || "").replace(/\D/g, "");
    if (cnpj.length !== 14) return toast("Digite um CNPJ com 14 dígitos");
    try {
      const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      if (!resp.ok) return toast("CNPJ não encontrado na Receita");
      const r = await resp.json();
      preencher({
        razaoSocial: r.razao_social, nome: r.nome_fantasia || r.razao_social, cep: r.cep ? MASK.cep(String(r.cep)) : "",
        logradouro: [r.descricao_tipo_de_logradouro, r.logradouro].filter(Boolean).join(" "), numero: r.numero, complemento: r.complemento,
        bairro: r.bairro, cidade: r.municipio, uf: r.uf, telefone: r.ddd_telefone_1 ? MASK.tel(String(r.ddd_telefone_1)) : "", contato: r.email,
      });
      toast("Dados preenchidos pela Receita Federal — confira antes de salvar");
    } catch { toast("Não foi possível consultar o CNPJ agora"); }
  }
});
// Reduz a imagem para no máximo 400 px e envia como WEBP.
async function reduzirImagem(file) {
  const bmp = await createImageBitmap(file);
  const escala = Math.min(1, 400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * escala); c.height = Math.round(bmp.height * escala);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.88));
  return blob || file;
}
const paraBase64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
async function enviarArquivo(col, dono, file, categoria = "documento", tipoDoc = "Outros") {
  if (file.size > 3 * 1024 * 1024) throw new Error(`"${file.name}" é maior que 3 MB`);
  return apiFetch("/api/arquivos", { col, dono, categoria, tipoDoc, nome: file.name, tipo: file.type || "application/octet-stream", dados: await paraBase64(file) });
}
async function salvarImagens(col, rec, images) {
  if (!db[col].includes(rec)) return; // o salvamento falhou e os dados foram recarregados
  for (const [k, file] of Object.entries(images)) {
    const antigo = rec[k];
    try {
      if (file) { const blob = await reduzirImagem(file); rec[k] = (await enviarArquivo(col, rec.id, new File([blob], file.name.replace(/\.\w+$/, "") + ".webp", { type: blob.type || "image/webp" }), SCHEMAS[col].fields.find((f) => f.k === k).categoria)).id; }
      else rec[k] = "";
      if (antigo) apiFetch(`/api/arquivos/${antigo}/excluir`, {}).catch(() => {});
    } catch (e) { toast(e.message); }
  }
  render();
}

document.getElementById("formCancel").addEventListener("click", () => dialog.close());
document.getElementById("formDelete").addEventListener("click", () => {
  const { col, id } = formCtx;
  const r = db[col].find((x) => x.id === id);
  if (!r || !confirm(`Excluir "${labelOf(r)}"?`)) return;
  db[col] = db[col].filter((x) => x.id !== id);
  log("Exclusão", `${SCHEMAS[col].singular}: ${labelOf(r)}`);
  dialog.close(); render();
});
document.getElementById("recordForm").addEventListener("submit", (e) => {
  const { col, id } = formCtx;
  const fd = new FormData(e.target);
  const data = {};
  for (const f of SCHEMAS[col].fields) {
    if (f.section || f.type === "image") continue;
    if (f.type === "bool") data[f.k] = fd.has(f.k);
    else if (f.type === "checks") data[f.k] = fd.getAll(f.k).map(String);
    else if (f.type === "money" || f.type === "number") data[f.k] = Number(fd.get(f.k)) || 0;
    else if (f.type === "password") { const v = String(fd.get(f.k) || ""); if (v) data[f.k] = v; }
    else data[f.k] = String(fd.get(f.k) ?? "").trim();
  }
  let rec;
  if (id) {
    rec = db[col].find((x) => x.id === id);
    Object.assign(rec, data);
    log("Edição", `${SCHEMAS[col].singular}: ${labelOf(data)}`);
  } else {
    rec = { id: uid(), ...formCtx.defaults, ...data };
    if (col === "contas") Object.assign(rec, { conciliado: false, aprovado: rec.tipo === "receber" || rec.valor < 5000 });
    db[col].push(rec);
    log("Criação", `${SCHEMAS[col].singular}: ${labelOf(data)}`);
  }
  save(); render();
  // Imagens são enviadas depois que o cadastro existe no servidor.
  const images = formCtx.images;
  if (Object.keys(images).length) syncChain.then(() => salvarImagens(col, rec, images));
});
const labelOf = (r) => r.descricao || r.nome || r.titulo || r.item || r.objeto || r.numero || "";

/* ---------- Componentes de tela ---------- */
const PILL = {
  pago: "green", emitida: "green", aprovado: "green", aprovada: "green", pedido: "blue", vigente: "green", ativo: "green",
  aberto: "yellow", "cotação": "yellow", solicitado: "purple", enviada: "blue", rascunho: "", "a vencer": "yellow",
  atrasado: "red", ganha: "green", apresentada: "blue", "em preparação": "yellow", cancelada: "", bloqueado: "red", "lançado": "green", conciliado: "green", processando: "yellow", erro: "red", hoje: "blue", agendado: "", "concluído": "green", "sem correspondência": "yellow", ignorado: "", pendente: "yellow", "previsão": "blue", recusado: "red", perdida: "red", cancelada: "red", encerrado: "", "aguardando aprovação": "purple", novo: "blue", arquivado: "", recebida: "green", "Nota fiscal": "purple", Boleto: "yellow", Contrato: "blue", negociação: "yellow", "contrato enviado": "blue", assinado: "green", publicado: "purple",
};
const pill = (s) => `<span class="pill pill--${PILL[s] ?? ""}">${escH(s)}</span>`;
const kpi = (label, value, hint = "", cls = "") => `<div class="kpi"><div class="kpi__label">${label}</div><div class="kpi__value ${cls}">${value}</div>${hint ? `<div class="kpi__hint">${hint}</div>` : ""}</div>`;
const contaStatus = (c) => (c.status === "pago" ? "pago" : !c.aprovado ? "aguardando aprovação" : c.vencimento < TODAY ? "atrasado" : "aberto");

// Tabela genérica. cols: [{label, get(r) -> html, num}], actions(r) -> [{label, cls, fn}]
let actionRegistry = new Map();
function table({ title, rows, cols, actions, addCol, addDefaults, filter, extra = "" }) {
  const q = (tableFilters[title] || "").toLowerCase();
  const visible = q ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)) : rows;
  const head = `<div class="panel__head"><h3 class="panel__title">${title} <span class="pill">${visible.length}</span></h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${filter !== false ? `<input class="filter-input" data-filter="${escH(title)}" placeholder="Buscar…" value="${escH(tableFilters[title] || "")}" />` : ""}
    ${extra}${addCol ? `<button class="btn-primary" data-act="${reg(() => openForm(addCol, null, addDefaults))}">+ Novo</button>` : ""}</div></div>`;
  if (!visible.length) return `<div class="panel">${head}<p class="empty">Nenhum registro.</p></div>`;
  return `<div class="panel">${head}<table class="table"><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${c.label}</th>`).join("")}${actions ? "<th></th>" : ""}</tr></thead>
    <tbody>${visible.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.get(r)}</td>`).join("")}${actions ? `<td><div class="row-actions">${actions(r).filter(Boolean).map((a) => `<button class="${a.cls || ""}" data-act="${reg(a.fn)}">${a.label}</button>`).join("")}</div></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
const tableFilters = {};
function reg(fn) { const k = uid(); actionRegistry.set(k, fn); return k; }
const editDel = (col) => (r) => [
  { label: "Editar", fn: () => openForm(col, r) },
  { label: "Excluir", cls: "no", fn: () => { if (confirm(`Excluir "${labelOf(r)}"?`)) { db[col] = db[col].filter((x) => x.id !== r.id); log("Exclusão", `${SCHEMAS[col].singular}: ${labelOf(r)}`); render(); } } },
];
const txt = (k) => (r) => escH(r[k]);
const money = (k) => (r) => BRL(r[k]);
const date = (k) => (r) => fmtDate(r[k]);

/* ---------- Cálculos ---------- */
function contratoInfo(k) {
  const status = k.fim < TODAY ? "encerrado" : k.inicio > TODAY ? "a vencer" : "vigente";
  const anos = Math.max(0, Math.floor((new Date(TODAY) - new Date(k.inicio)) / (365.25 * 864e5)));
  const valorAtual = k.valorMensal * Math.pow(1 + (k.reajuste || 0) / 100, anos);
  const total = Math.max(1, Math.round((new Date(k.fim) - new Date(k.inicio)) / (30.44 * 864e5)));
  const restantes = status === "encerrado" ? 0 : Math.max(0, Math.round((new Date(k.fim) - new Date(Math.max(new Date(TODAY), new Date(k.inicio)))) / (30.44 * 864e5)));
  const proxReajuste = addMonths(k.inicio, 12 * (anos + 1));
  return { status, valorAtual, total, restantes, proxReajuste };
}
function projetoInfo(p) {
  const custoInterno = p.horas * p.valorHora;
  const custo = custoInterno + p.custoTerceiros;
  const margem = p.orcamento - custo;
  return { custoInterno, custo, margem, pct: p.orcamento ? margem / p.orcamento : 0, consumo: p.orcamento ? custo / p.orcamento : 0 };
}
function fluxoMeses(from = -3, to = 2) {
  const out = [];
  for (let i = from; i <= to; i++) {
    const key = monthKey(addMonths(TODAY.slice(0, 8) + "15", i));
    const doMes = db.contas.filter((c) => monthKey(c.vencimento) === key);
    const ent = sum(doMes.filter((c) => c.tipo === "receber"), (c) => c.valor);
    const sai = sum(doMes.filter((c) => c.tipo === "pagar"), (c) => c.valor);
    const realizado = sum(doMes.filter((c) => c.status === "pago"), (c) => (c.tipo === "receber" ? c.valor : -c.valor));
    out.push({ key, ent, sai, saldo: ent - sai, realizado, previsto: key >= monthKey(TODAY) });
  }
  return out;
}
const receber = () => db.contas.filter((c) => c.tipo === "receber");
const pagar = () => db.contas.filter((c) => c.tipo === "pagar");
const inadimplentes = () => receber().filter((c) => contaStatus(c) === "atrasado");
const folhaMensal = () => sum(db.colaboradores, (e) => e.salario * encargo() + e.beneficios);

function bars(meses) {
  const max = Math.max(1, ...meses.flatMap((x) => [x.ent, x.sai]));
  return `<div class="bars">${meses.map((x) => `<div class="bars__group" title="Entradas ${BRL(x.ent)} · Saídas ${BRL(x.sai)}">
    <div class="bars__pair"><i class="bars__in" style="height:${(x.ent / max) * 100}%;${x.previsto ? "opacity:.55" : ""}"></i><i class="bars__out" style="height:${(x.sai / max) * 100}%;${x.previsto ? "opacity:.55" : ""}"></i></div>
    <span class="bars__label">${monthLabel(x.key)}</span></div>`).join("")}</div>
    <div class="legend"><span><i class="bars__in"></i>Entradas</span><span><i class="bars__out"></i>Saídas</span><span>Barras claras = previsão</span></div>`;
}

/* ---------- Ações de negócio ---------- */
function marcarPago(c) { c.status = "pago"; log(c.tipo === "receber" ? "Recebimento" : "Pagamento", `${c.descricao} — ${BRL(c.valor)}`); toast("Baixa registrada"); render(); }
async function cobrar(c) {
  if (!asaasOn()) { log("Cobrança registrada", `${c.parceiro}: ${c.descricao} — ${BRL(c.valor)}`); toast("Cobrança registrada (Asaas não configurado)"); return render(); }
  try { await apiAction("/api/integracoes/cobranca", { contaId: c.id }); toast("Cobrança criada no Asaas"); } catch (e) { toast(e.message); }
}
async function sincronizar(col, r) {
  try { await apiAction("/api/integracoes/sincronizar", { col, id: r.id }); toast("Status atualizado"); } catch (e) { toast(e.message); }
}
function copiar(texto) { navigator.clipboard?.writeText(texto).then(() => toast("Copiado"), () => prompt("Copie:", texto)); }
function conciliar(c) { c.conciliado = !c.conciliado; log(c.conciliado ? "Conciliação" : "Conciliação desfeita", `${c.descricao} — ${BRL(c.valor)}`); render(); }
async function emitirNota(c) {
  if (asaasOn()) {
    try { await apiAction("/api/integracoes/nfse", { contaId: c.id }); toast("NFS-e enviada para emissão"); } catch (e) { toast(e.message); }
    return;
  }
  const ultimo = Math.max(0, ...db.notas.map((n) => Number(n.numero) || 0));
  const numero = String(ultimo + 1).padStart(6, "0");
  db.notas.push({ id: uid(), numero, cliente: c.parceiro, valor: c.valor, emissao: TODAY, status: "emitida", contabilidade: false, conta: c.id });
  c.nota = numero; log("NF emitida", `NF ${numero} — ${c.parceiro} — ${BRL(c.valor)}`); toast(`NF ${numero} emitida`); render();
}
function enviarContabilidade(list) {
  const pend = list.filter((n) => !n.contabilidade && n.status === "emitida");
  pend.forEach((n) => (n.contabilidade = true));
  log("Integração contábil", `${pend.length} nota(s) enviada(s) à contabilidade`); toast(`${pend.length} nota(s) enviada(s)`); render();
}
function gerarParcela(k) {
  const info = contratoInfo(k);
  const dia = String(Math.min(28, Math.max(1, Number(k.diaVencimento) || 10))).padStart(2, "0");
  const venc = addMonths(TODAY.slice(0, 8) + dia, 1);
  const id = `rec-${k.id}-${monthKey(venc)}`;
  if (db.contas.some((c) => c.id === id || (c.contrato === k.id && monthKey(c.vencimento) === monthKey(venc)))) return toast("Parcela do próximo mês já gerada");
  db.contas.push({ id, tipo: "receber", descricao: `Parcela contrato — ${k.objeto}`, parceiro: k.cliente, categoria: "Fee", valor: Math.round(info.valorAtual), vencimento: venc, status: "aberto", conciliado: false, aprovado: true, contrato: k.id });
  log("Cobrança recorrente", `${k.cliente}: parcela de ${BRL(info.valorAtual)} para ${fmtDate(venc)}`); toast("Parcela gerada em Contas a receber"); render();
}
function decidirCompra(p, ok) {
  if (!canApprove()) return toast("Seu perfil não pode aprovar");
  p.status = ok ? "aprovado" : "recusado";
  if (ok) db.contas.push({ id: uid(), tipo: "pagar", descricao: `Compra: ${p.item}`, parceiro: p.fornecedor || "A definir", categoria: "Outros", valor: p.valor, vencimento: addMonths(TODAY, 1), status: "aberto", conciliado: false, aprovado: true });
  log(ok ? "Compra aprovada" : "Compra recusada", `${p.item} — ${BRL(p.valor)}`); render();
}
function decidirDespesa(c, ok) {
  if (!canApprove()) return toast("Seu perfil não pode aprovar");
  if (ok) c.aprovado = true; else db.contas = db.contas.filter((x) => x.id !== c.id);
  log(ok ? "Despesa aprovada" : "Despesa recusada", `${c.descricao} — ${BRL(c.valor)}`); render();
}
function converterProposta(v) {
  v.status = "pedido";
  db.contratos.push({ id: uid(), cliente: v.cliente, objeto: v.titulo, valorMensal: Math.round(v.valor / 6), inicio: TODAY, fim: addMonths(TODAY, 6), reajuste: 0, indice: "—" });
  if (!db.projetos.some((p) => p.nome === v.titulo)) db.projetos.push({ id: uid(), nome: v.titulo, cliente: v.cliente, orcamento: v.valor, custoTerceiros: 0, horas: 0, valorHora: 140 });
  log("Pedido gerado", `${v.cliente}: ${v.titulo} → contrato e projeto criados`); toast("Pedido gerado: contrato e projeto criados"); render();
}
function exportarCSV(nome, header, rows) {
  const csv = [header, ...rows].map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  a.download = nome; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  log("Exportação", nome);
}

/* ----- Links de pastas ----- */
function parseLinks(txt) {
  return String(txt || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [a, b] = l.includes("|") ? l.split("|").map((x) => x.trim()) : ["", l];
    const url = b || a;
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return { nome: a || u.hostname, url: u.href }; } catch { return null; }
  }).filter(Boolean);
}
const linksHtml = (rec) => { const l = parseLinks(rec.links); return l.length ? `<div class="links">${l.map((x) => `<a class="link-chip" href="${escH(x.url)}" target="_blank" rel="noopener noreferrer">🔗 ${escH(x.nome)}</a>`).join("")}</div>` : ""; };

/* ----- Documentos anexados ----- */
const TIPOS_DOC = {
  colaboradores: ["Contrato de trabalho", "Contrato PJ", "RG / CNH", "CPF", "Comprovante de residência", "Carteira de trabalho", "Atestado / exame", "Certificado", "Outros"],
  clientes: ["Contrato", "Aditivo", "Proposta assinada", "Cartão CNPJ", "Briefing", "NDA", "Outros"],
  fornecedores: ["Contrato", "Orçamento", "Cartão CNPJ", "Nota fiscal", "Outros"],
  contratos: ["Contrato assinado", "Aditivo", "Distrato", "Outros"],
  concorrencias: ["Briefing / edital", "Apresentação", "Orçamento", "Comprovante de gasto", "Outros"],
  projetos: ["Briefing", "Cronograma", "Aprovação", "Outros"],
  influenciadores: ["Contrato", "Nota fiscal", "Mídia kit", "Comprovante", "Documento pessoal", "Outros"],
  influContratos: ["Contrato assinado", "Nota fiscal", "Comprovante", "Print de publicação", "Outros"],
  emails: ["Nota fiscal", "Boleto", "Contrato", "Comprovante", "Outros"],
};
const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const docsCount = (col, id) => db.docs?.[col]?.[id] || 0;
const docsAction = (col) => (r) => ({ label: `Documentos (${docsCount(col, r.id)})`, fn: () => abrirDocumentos(col, r) });
async function abrirDocumentos(col, rec) {
  let dlg = document.getElementById("docDialog");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "docDialog"; dlg.className = "dialog dialog--wide"; document.body.appendChild(dlg); }
  const podeEditar = can(MODULO_DOC[col]);
  const draw = async () => {
    let lista = [];
    try { lista = await apiFetch(`/api/arquivos?col=${col}&dono=${encodeURIComponent(rec.id)}`); } catch (e) { toast(e.message); }
    db.docs ||= {}; (db.docs[col] ||= {})[rec.id] = lista.length;
    const tipos = TIPOS_DOC[col] || ["Outros"];
    dlg.innerHTML = `<h2>Documentos — ${escH(labelOf(rec))}</h2>
      ${parseLinks(rec.links).length ? `<h3 class="form-section">Links de pastas</h3>${linksHtml(rec)}<h3 class="form-section">Arquivos</h3>` : ""}
      ${lista.length ? `<table class="table"><thead><tr><th>Arquivo</th><th>Tipo</th><th class="num">Tamanho</th><th>Enviado por</th><th>Data</th><th></th></tr></thead><tbody>
        ${lista.map((a) => `<tr><td><a href="${fileUrl(a.id)}" target="_blank" rel="noopener">${escH(a.nome)}</a></td><td>${pill(a.tipo_doc || "Outros")}</td><td class="num">${fmtBytes(a.tamanho)}</td>
          <td>${escH(a.criado_por)}</td><td>${new Date(a.criado_em).toLocaleDateString("pt-BR")}</td>
          <td><div class="row-actions"><a class="btn-mini" href="${fileUrl(a.id)}" download="${escH(a.nome)}">Baixar</a>${podeEditar ? `<button class="no" data-del="${a.id}">Excluir</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table>` : `<p class="empty">Nenhum documento anexado.</p>`}
      ${podeEditar ? `<label class="doc-tipo">Tipo do documento <select id="docTipo">${tipos.map((t) => `<option>${escH(t)}</option>`).join("")}</select></label>
        <label class="dropzone" id="docDrop"><input type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt" />
        <b>Clique para anexar</b> ou arraste arquivos aqui<br /><span class="crumbs">PDF, imagens, Word, Excel, CSV ou TXT · até 3 MB cada</span></label>` : ""}
      <div class="dialog__actions"><button class="btn-ghost" data-close>Fechar</button></div>`;
  };
  const enviar = async (files) => {
    for (const f of files) {
      try { toast(`Enviando ${f.name}…`); await enviarArquivo(col, rec.id, f, "documento", document.getElementById("docTipo")?.value); } catch (e) { toast(e.message); }
    }
    await draw(); renderView();
  };
  dlg.onclick = async (e) => {
    if (e.target.closest("[data-close]")) return dlg.close();
    const del = e.target.closest("[data-del]");
    if (del && confirm("Excluir este documento?")) {
      try { await apiFetch(`/api/arquivos/${del.dataset.del}/excluir`, {}); } catch (err) { toast(err.message); }
      await draw(); renderView();
    }
  };
  dlg.onchange = (e) => { if (e.target.type === "file" && e.target.files.length) enviar([...e.target.files]); };
  dlg.onclose = () => renderView();
  dlg.ondragover = (e) => { e.preventDefault(); document.getElementById("docDrop")?.classList.add("is-over"); };
  dlg.ondragleave = () => document.getElementById("docDrop")?.classList.remove("is-over");
  dlg.ondrop = (e) => { e.preventDefault(); if (podeEditar && e.dataTransfer.files.length) enviar([...e.dataTransfer.files]); };
  await draw(); dlg.showModal();
}
const MODULO_DOC = { concorrencias: "vendas", clientes: "vendas", fornecedores: "compras", contratos: "contratos", colaboradores: "pessoas", projetos: "servicos", influenciadores: "influenciadores", influContratos: "influenciadores", emails: "emails" };
const thumb = (id, nome, redondo) => `<span class="thumb-cell">${id ? `<img class="thumb ${redondo ? "thumb--round" : ""}" src="${fileUrl(id)}" alt="" loading="lazy" />` : `<span class="thumb thumb--empty ${redondo ? "thumb--round" : ""}">${escH(String(nome || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase())}</span>`}${escH(nome)}</span>`;

/* ----- Cotações lado a lado ----- */
function abrirCotacoes(p) {
  p.cotacoesLista ||= [];
  let dlg = document.getElementById("cotDialog");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "cotDialog"; dlg.className = "dialog dialog--wide"; document.body.appendChild(dlg); }
  const draw = () => {
    const l = p.cotacoesLista;
    const menor = l.length ? Math.min(...l.map((c) => c.valor)) : null;
    const podeEditar = !["aprovado", "recusado"].includes(p.status);
    dlg.innerHTML = `<h2>Cotações — ${escH(p.item)}</h2>
      ${l.length ? `<table class="table"><thead><tr><th>Fornecedor</th><th class="num">Valor</th><th class="num">Prazo (dias)</th><th>Observação</th><th></th></tr></thead><tbody>
        ${l.map((c, i) => `<tr class="${c.escolhida ? "row--chosen" : ""}"><td>${escH(c.fornecedor)}${c.valor === menor ? ` <span class="pill pill--green">menor preço</span>` : ""}${c.escolhida ? ` <span class="pill pill--blue">escolhida</span>` : ""}</td>
          <td class="num">${BRL(c.valor)}</td><td class="num">${c.prazo ?? "—"}</td><td>${escH(c.obs || "")}</td>
          <td><div class="row-actions">${podeEditar ? `<button class="ok" data-pick="${i}">Escolher</button><button class="no" data-del="${i}">Remover</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table>` : `<p class="empty">Nenhuma cotação ainda.</p>`}
      ${podeEditar ? `<form class="form-grid" id="cotForm" style="margin-top:16px">
        <label>Fornecedor<input name="fornecedor" list="cotForn" required /></label>
        <datalist id="cotForn">${db.fornecedores.map((f) => `<option value="${escH(f.nome)}">`).join("")}</datalist>
        <label>Valor<input name="valor" type="number" step="0.01" min="0" required /></label>
        <label>Prazo de entrega (dias)<input name="prazo" type="number" min="0" /></label>
        <label>Observação<input name="obs" /></label>
        <div class="dialog__actions full" style="grid-column:1/-1;margin-top:0"><button class="btn-primary" type="submit">Adicionar cotação</button></div></form>` : ""}
      <div class="dialog__actions"><button class="btn-ghost" data-close>Fechar</button></div>`;
  };
  dlg.onclick = (e) => {
    if (e.target.closest("[data-close]")) { dlg.close(); return; }
    const pick = e.target.closest("[data-pick]"), del = e.target.closest("[data-del]");
    if (pick) {
      const c = p.cotacoesLista[Number(pick.dataset.pick)];
      p.cotacoesLista.forEach((x) => (x.escolhida = x === c));
      p.fornecedor = c.fornecedor; p.valor = c.valor;
      log("Cotação escolhida", `${p.item}: ${c.fornecedor} — ${BRL(c.valor)}`); render(); draw();
    }
    if (del) { p.cotacoesLista.splice(Number(del.dataset.del), 1); render(); draw(); }
  };
  dlg.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    p.cotacoesLista.push({ fornecedor: String(fd.get("fornecedor")).trim(), valor: Number(fd.get("valor")) || 0, prazo: fd.get("prazo") === "" ? null : Number(fd.get("prazo")), obs: String(fd.get("obs") || "").trim() });
    if (p.status === "solicitado") p.status = "cotação";
    log("Cotação registrada", `${p.item}: ${fd.get("fornecedor")} — ${BRL(fd.get("valor"))}`); render(); draw();
  };
  draw(); dlg.showModal();
}

/* ----- Follow-ups comerciais ----- */
const followStatus = (a) => (a.concluida ? "concluído" : a.data < TODAY ? "atrasado" : a.data === TODAY ? "hoje" : "agendado");
function renderFollowups() {
  const rows = [...db.atividades].sort((a, b) => Number(a.concluida) - Number(b.concluida) || a.data.localeCompare(b.data));
  const abertos = db.atividades.filter((a) => !a.concluida);
  const atras = abertos.filter((a) => a.data < TODAY);
  return `<div class="kpis">${kpi("Follow-ups atrasados", atras.length, "", atras.length ? "neg" : "pos")}${kpi("Para hoje", abertos.filter((a) => a.data === TODAY).length)}${kpi("Próximos 7 dias", abertos.filter((a) => a.data > TODAY && a.data <= addDays(TODAY, 7)).length)}</div>` +
    table({ title: "Agenda de follow-ups", rows, addCol: "atividades", addDefaults: { data: TODAY, tipo: "Ligação", responsavel: currentUser().nome, concluida: false },
      cols: [{ label: "Data", get: date("data") }, { label: "Cliente", get: txt("cliente") }, { label: "Proposta", get: (r) => escH(r.proposta || "—") }, { label: "Tipo", get: (r) => pill(r.tipo) },
        { label: "O que fazer", get: txt("descricao") }, { label: "Responsável", get: txt("responsavel") }, { label: "Status", get: (r) => pill(followStatus(r)) }],
      actions: (r) => [!r.concluida && { label: "Concluir", cls: "ok", fn: () => { r.concluida = true; log("Follow-up concluído", `${r.cliente}: ${r.descricao}`); render(); } }, ...editDel("atividades")(r)] });
}
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

/* ---------- Módulos ---------- */
const ICON = {
  overview: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  projetos: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  financeiro: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  faturamento: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h3"/>',
  compras: '<path d="M4 5h2l2 11h10l2-8H7"/><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/>',
  vendas: '<path d="M4 18 10 12l4 4 6-8"/><path d="M15 8h5v5"/>',
  contratos: '<path d="M7 3h10v18H7z"/><path d="M10 8h4M10 12h4M10 16l1.5 1.5L14 15"/>',
  servicos: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  pessoas: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  relatorios: '<path d="M6 20v-6M12 20V6M18 20v-9"/>',
  usuarios: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M17 11v6M14 14h6"/>',
  aprovacoes: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  influenciadores: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  emails: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
};

const MODULES = {
  overview: { label: "Visão geral", render: renderOverview },
  projetos: { label: "Projetos (Kanban)" },
  financeiro: { label: "Financeiro", tabs: {
    "Contas a receber": () => contasTable("receber"),
    "Contas a pagar": () => contasTable("pagar"),
    "Fluxo de caixa": renderFluxo,
    "Conciliação bancária": renderConciliacao,
    "Mídia e repasses": renderMidias,
  } },
  faturamento: { label: "Faturamento e fiscal", render: renderFaturamento },
  compras: { label: "Compras e fornecedores", tabs: {
    "Solicitações e cotações": () => table({ title: "Solicitações de compra", rows: db.compras, addCol: "compras", addDefaults: { status: "solicitado", solicitante: currentUser().nome, cotacoes: 0 },
      cols: [{ label: "Item", get: txt("item") }, { label: "Fornecedor", get: (r) => escH(r.fornecedor || "—") }, { label: "Solicitante", get: txt("solicitante") }, { label: "Cotações", get: (r) => (r.cotacoesLista || []).length, num: true }, { label: "Melhor preço", num: true, get: (r) => { const l = r.cotacoesLista || []; return l.length ? BRL(Math.min(...l.map((c) => c.valor))) : "—"; } }, { label: "Valor", get: money("valor"), num: true }, { label: "Status", get: (r) => pill(r.status) }],
      actions: (r) => [
        { label: `Cotações (${(r.cotacoesLista || []).length})`, cls: "main", fn: () => abrirCotacoes(r) },
        ...editDel("compras")(r)] }),
    Fornecedores: () => table({ title: "Fornecedores", rows: db.fornecedores, addCol: "fornecedores",
      cols: [{ label: "Nome", get: txt("nome") }, { label: "CNPJ", get: txt("cnpj") }, { label: "Contato", get: (r) => escH([r.contato, r.telefone].filter(Boolean).join(" · ") || "—") }, { label: "Categoria", get: (r) => pill(r.categoria) },
        { label: "Total a pagar", num: true, get: (r) => BRL(sum(pagar().filter((c) => c.parceiro === r.nome && c.status !== "pago"), (c) => c.valor)) }],
      actions: (r) => [docsAction("fornecedores")(r), ...editDel("fornecedores")(r)] }),
  } },
  vendas: { label: "Vendas e clientes", tabs: {
    "Propostas e pedidos": renderPropostas,
    "Follow-ups": renderFollowups,
    Concorrências: renderConcorrencias,
    Clientes: () => table({ title: "Clientes", rows: db.clientes, addCol: "clientes",
      cols: [{ label: "Cliente", get: (r) => thumb(r.logoId, r.nome) }, { label: "CNPJ", get: txt("cnpj") }, { label: "Contato", get: (r) => escH([r.contatoNome, r.contato, r.telefone].filter(Boolean).join(" · ") || "—") }, { label: "Cidade", get: (r) => escH([r.cidade, r.uf].filter(Boolean).join("/") || "—") }, { label: "Segmento", get: (r) => (r.segmento ? pill(r.segmento) : "—") },
        { label: "Receita (12m)", num: true, get: (r) => BRL(sum(receber().filter((c) => c.parceiro === r.nome && c.status === "pago"), (c) => c.valor)) },
        { label: "Em aberto", num: true, get: (r) => BRL(sum(receber().filter((c) => c.parceiro === r.nome && c.status !== "pago"), (c) => c.valor)) }],
      actions: (r) => [docsAction("clientes")(r), ...editDel("clientes")(r)] }),
  } },
  contratos: { label: "Contratos", render: renderContratos },
  servicos: { label: "Projetos e serviços", render: renderServicos },
  pessoas: { label: "Pessoas", render: renderPessoas },
  relatorios: { label: "Relatórios gerenciais", tabs: { "Visão geral": renderRelatorios, DRE: renderDRE, "Orçado × realizado": renderOrcado, "Rentabilidade por cliente": renderPorCliente } },
  emails: { label: "Caixa de e-mails", render: renderEmails },
  influenciadores: { label: "Influenciadores", tabs: { "Contratos e pagamentos": renderInfluContratos, Influenciadores: renderInfluenciadores } },
  usuarios: { label: "Usuários e acessos", tabs: { Usuários: renderUsuarios, "Permissões por perfil": renderMatriz } },
  aprovacoes: { label: "Aprovações e configurações", tabs: {
    "Aprovações pendentes": renderAprovacoes,
    "Configurações": renderConfig,
    "Custos de APIs": renderCustosApi,
    "Histórico de alterações": () => table({ title: "Histórico de alterações", rows: db.historico,
      cols: [{ label: "Quando", get: txt("quando") }, { label: "Usuário", get: txt("usuario") }, { label: "Ação", get: (r) => pill(r.acao) }, { label: "Detalhe", get: txt("detalhe") }] }),
  } },
};

function contasTable(tipo) {
  const rows = db.contas.filter((c) => c.tipo === tipo).sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  const aberto = rows.filter((c) => c.status !== "pago");
  const atras = aberto.filter((c) => contaStatus(c) === "atrasado");
  const prox30 = aberto.filter((c) => c.vencimento >= TODAY && c.vencimento <= addMonths(TODAY, 1));
  return `<div class="kpis">
    ${kpi(tipo === "receber" ? "A receber (em aberto)" : "A pagar (em aberto)", BRL(sum(aberto, (c) => c.valor)), `${aberto.length} lançamentos`)}
    ${kpi("Vencidos", BRL(sum(atras, (c) => c.valor)), `${atras.length} lançamentos`, atras.length ? "neg" : "")}
    ${kpi("Previsão próximos 30 dias", BRL(sum(prox30, (c) => c.valor)), `${prox30.length} vencimentos`)}
  </div>` + table({ title: tipo === "receber" ? "Contas a receber" : "Contas a pagar", rows, addCol: "contas", addDefaults: { tipo, status: "aberto", vencimento: TODAY },
    cols: [{ label: "Vencimento", get: date("vencimento") }, { label: "Descrição", get: txt("descricao") }, { label: tipo === "receber" ? "Cliente" : "Fornecedor", get: txt("parceiro") },
      { label: "Categoria", get: txt("categoria") }, { label: "Valor", get: money("valor"), num: true }, { label: "Status", get: (r) => pill(contaStatus(r)) },
      ...(tipo === "receber" ? [{ label: "NF", get: (r) => (r.nota ? escH(r.nota) : "—") },
        { label: "Cobrança", get: (r) => (r.asaas?.url ? `<a href="${escH(r.asaas.url)}" target="_blank" rel="noopener">abrir</a>` : "—") }] : [])],
    actions: (r) => [
      r.status !== "pago" && r.aprovado && { label: tipo === "receber" ? "Receber" : "Pagar", cls: "ok", fn: () => marcarPago(r) },
      tipo === "receber" && r.status !== "pago" && !r.asaas && (asaasOn() || contaStatus(r) === "atrasado") && { label: asaasOn() ? "Gerar boleto/Pix" : "Cobrar", cls: "main", fn: () => cobrar(r) },
      r.asaas?.pix && r.status !== "pago" && { label: "Copiar Pix", fn: () => copiar(r.asaas.pix) },
      r.asaas?.id && r.status !== "pago" && { label: "Atualizar", fn: () => sincronizar("contas", r) },
      tipo === "receber" && !r.nota && { label: asaasOn() ? "Emitir NFS-e" : "Registrar NF", fn: () => emitirNota(r) },
      ...editDel("contas")(r)] });
}

function renderOverview() {
  const meses = fluxoMeses();
  const atual = meses.find((x) => x.key === monthKey(TODAY));
  const saldo = sum(db.contas.filter((c) => c.status === "pago"), (c) => (c.tipo === "receber" ? c.valor : -c.valor));
  const inad = inadimplentes();
  const pend = db.compras.filter((p) => ["solicitado", "cotação"].includes(p.status)).length + pagar().filter((c) => !c.aprovado).length;
  const vencendo = db.contratos.filter((k) => contratoInfo(k).status === "vigente" && k.fim <= addMonths(TODAY, 3));
  return `<div class="kpis">
    ${kpi("Saldo em caixa (realizado)", BRL(saldo), "entradas pagas − saídas pagas", saldo >= 0 ? "pos" : "neg")}
    ${kpi("Receita prevista no mês", BRL(atual.ent), monthLabel(atual.key))}
    ${kpi("Despesas previstas no mês", BRL(atual.sai), monthLabel(atual.key))}
    ${kpi("Inadimplência", BRL(sum(inad, (c) => c.valor)), `${inad.length} cobranças vencidas`, inad.length ? "neg" : "")}
    ${kpi("Aprovações pendentes", pend, "compras e despesas")}
    ${kpi("Follow-ups atrasados", db.atividades.filter((a) => !a.concluida && a.data < TODAY).length, "Vendas e clientes", db.atividades.some((a) => !a.concluida && a.data < TODAY) ? "neg" : "")}
    ${kpi("Contratos vigentes", db.contratos.filter((k) => contratoInfo(k).status === "vigente").length, `${vencendo.length} vencem em até 3 meses`)}
  </div>
  <div class="grid-2">
    <div class="panel"><div class="panel__head"><h3 class="panel__title">Fluxo de caixa</h3></div>${bars(meses)}</div>
    ${table({ title: "Próximos vencimentos", filter: false, rows: db.contas.filter((c) => c.status !== "pago").sort((a, b) => a.vencimento.localeCompare(b.vencimento)).slice(0, 6),
      cols: [{ label: "Venc.", get: date("vencimento") }, { label: "Descrição", get: txt("descricao") }, { label: "Tipo", get: (r) => pill(r.tipo) }, { label: "Valor", get: money("valor"), num: true }, { label: "Status", get: (r) => pill(contaStatus(r)) }] })}
  </div>`;
}

function renderFluxo() {
  const meses = fluxoMeses(-3, 3);
  let acc = 0;
  return `<div class="panel"><div class="panel__head"><h3 class="panel__title">Fluxo de caixa — realizado e previsto</h3></div>${bars(meses.slice(0, 6))}</div>` +
    table({ title: "Fluxo mensal", filter: false, rows: meses.map((x) => ({ ...x, acc: (acc += x.saldo) })),
      cols: [{ label: "Mês", get: (r) => monthLabel(r.key) + (r.previsto ? " " + pill("previsão") : "") }, { label: "Entradas", get: money("ent"), num: true }, { label: "Saídas", get: money("sai"), num: true },
        { label: "Saldo do mês", num: true, get: (r) => `<span class="${r.saldo >= 0 ? "pos" : "neg"}">${BRL(r.saldo)}</span>` }, { label: "Acumulado", num: true, get: (r) => BRL(r.acc) }] });
}

/* ----- Extrato bancário: importação (OFX/CSV) e conciliação automática ----- */
function parseValorBR(v) {
  let t = String(v).trim().replace(/[R$\s]/g, "");
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  return Number(t);
}
function parseData(v) {
  const t = String(v).trim();
  let m;
  if ((m = t.match(/^(\d{4})(\d{2})(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
function parseOFX(txt) {
  const tag = (bloco, nome) => (bloco.match(new RegExp(`<${nome}>([^<\r\n]*)`, "i")) || [])[1]?.trim() || "";
  return txt.split(/<STMTTRN>/i).slice(1).map((b) => ({
    fitid: tag(b, "FITID"), data: parseData(tag(b, "DTPOSTED")), valor: parseValorBR(tag(b, "TRNAMT").replace(",", ".")),
    descricao: tag(b, "MEMO") || tag(b, "NAME") || "Movimento",
  })).filter((l) => l.data && Number.isFinite(l.valor) && l.valor !== 0);
}
function parseCSV(txt) {
  const linhas = txt.split(/\r?\n/).filter((l) => l.trim());
  const sep = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ";" : ",";
  const out = [];
  for (const linha of linhas) {
    const cols = linha.split(sep).map((c) => c.replace(/^"|"$/g, "").trim());
    const iData = cols.findIndex((c) => parseData(c));
    if (iData < 0) continue; // cabeçalho ou linha sem data
    const nums = cols.map((c, i) => ({ i, v: /\d/.test(c) && i !== iData && /^[-+R$\s\d.,]+$/.test(c) ? parseValorBR(c) : NaN })).filter((x) => Number.isFinite(x.v));
    if (!nums.length) continue;
    const valor = nums[0].v; // primeira coluna numérica após a data = valor (saldo costuma vir depois)
    const descricao = cols.filter((c, i) => i !== iData && !nums.some((n) => n.i === i)).sort((x, y) => y.length - x.length)[0] || "Movimento";
    if (valor) out.push({ fitid: "", data: parseData(cols[iData]), valor, descricao });
  }
  return out;
}
const diasEntre = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;
// Procura um lançamento com o mesmo valor e sentido, vencimento até 7 dias de distância, ainda não conciliado.
function melhorLancamento(linha) {
  const tipo = linha.valor > 0 ? "receber" : "pagar";
  const usados = new Set(db.extrato.map((x) => x.contaId).filter(Boolean));
  return db.contas
    .filter((c) => c.tipo === tipo && !c.conciliado && !usados.has(c.id) && Math.abs(c.valor - Math.abs(linha.valor)) < 0.01 && diasEntre(c.vencimento, linha.data) <= 7 && (c.aprovado || c.status === "pago"))
    .sort((x, y) => diasEntre(x.vencimento, linha.data) - diasEntre(y.vencimento, linha.data))[0];
}
function vincular(linha, conta) {
  linha.contaId = conta.id; linha.status = "conciliado";
  conta.conciliado = true; conta.status = "pago"; conta.extratoId = linha.id;
}
async function importarExtrato(file) {
  const txt = await file.text();
  const linhas = /<OFX>|<STMTTRN>/i.test(txt) ? parseOFX(txt) : parseCSV(txt);
  if (!linhas.length) return toast("Nenhum movimento encontrado no arquivo");
  let novos = 0, conciliados = 0;
  for (const l of linhas) {
    const id = "x" + (l.fitid ? l.fitid : `${l.data}|${l.valor}|${l.descricao}`).split("").reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7).toString(36);
    if (db.extrato.some((x) => x.id === id)) continue;
    const linha = { id, data: l.data, valor: l.valor, descricao: l.descricao.slice(0, 200), status: "sem correspondência", arquivo: file.name };
    db.extrato.push(linha); novos++;
    const conta = melhorLancamento(linha);
    if (conta) { vincular(linha, conta); conciliados++; }
  }
  log("Extrato importado", `${file.name}: ${novos} movimentos novos, ${conciliados} conciliados automaticamente`);
  toast(`${novos} movimentos importados · ${conciliados} conciliados automaticamente`);
  render();
}

function renderConciliacao() {
  const ext = [...db.extrato].sort((a, b) => b.data.localeCompare(a.data));
  const semPar = ext.filter((x) => x.status === "sem correspondência");
  const pagos = db.contas.filter((c) => c.status === "pago").sort((a, b) => b.vencimento.localeCompare(a.vencimento));
  const pend = pagos.filter((c) => !c.conciliado);
  const upload = reg(() => document.getElementById("extratoFile").click());
  return `<div class="kpis">${kpi("Movimentos no extrato", ext.length)}${kpi("Conciliados automaticamente", ext.filter((x) => x.status === "conciliado").length, "", "pos")}${kpi("Extrato sem correspondência", semPar.length, BRL(sum(semPar, (x) => Math.abs(x.valor))), semPar.length ? "neg" : "")}${kpi("Lançamentos pagos sem extrato", pend.length, BRL(sum(pend, (c) => c.valor)))}</div>
    <div class="panel"><div class="panel__head"><h3 class="panel__title">Importar extrato bancário</h3>
      <button class="btn-primary" data-act="${upload}">Importar OFX ou CSV</button></div>
      <input type="file" id="extratoFile" accept=".ofx,.csv,.txt" hidden />
      <p class="empty">Exporte o extrato no internet banking em <b>OFX</b> (recomendado) ou <b>CSV</b> com data, descrição e valor. Cada movimento é comparado com Contas a pagar e a receber pelo valor e pela data (até 7 dias de diferença); quando bate, o lançamento é baixado e conciliado. Importar o mesmo arquivo duas vezes não duplica movimentos.</p></div>` +
    table({ title: "Movimentos do extrato", rows: ext,
      cols: [{ label: "Data", get: date("data") }, { label: "Descrição", get: txt("descricao") },
        { label: "Valor", num: true, get: (r) => `<span class="${r.valor > 0 ? "pos" : "neg"}">${r.valor > 0 ? "+" : "−"} ${BRL(Math.abs(r.valor))}</span>` },
        { label: "Situação", get: (r) => pill(r.status) },
        { label: "Lançamento", get: (r) => { const c = db.contas.find((x) => x.id === r.contaId); return c ? escH(`${c.descricao} · ${c.parceiro}`) : "—"; } }],
      actions: (r) => r.status === "conciliado"
        ? [{ label: "Desvincular", fn: () => { const c = db.contas.find((x) => x.id === r.contaId); if (c) { c.conciliado = false; delete c.extratoId; } r.contaId = ""; r.status = "sem correspondência"; log("Conciliação desfeita", r.descricao); render(); } }]
        : [
          r.status === "sem correspondência" && { label: "Vincular…", cls: "main", fn: () => escolherLancamento(r) },
          r.status === "sem correspondência" && { label: "Criar lançamento", fn: () => {
            const c = { id: uid(), tipo: r.valor > 0 ? "receber" : "pagar", descricao: r.descricao, parceiro: "Extrato bancário", categoria: "Outros", valor: Math.abs(r.valor), vencimento: r.data, status: "pago", conciliado: true, aprovado: true, extratoId: r.id };
            db.contas.push(c); r.contaId = c.id; r.status = "conciliado"; log("Lançamento criado do extrato", `${r.descricao} — ${BRL(c.valor)}`); render(); } },
          { label: r.status === "ignorado" ? "Reativar" : "Ignorar", fn: () => { r.status = r.status === "ignorado" ? "sem correspondência" : "ignorado"; render(); } },
        ] }) +
    table({ title: "Lançamentos pagos ainda sem extrato", rows: pend,
      cols: [{ label: "Data", get: date("vencimento") }, { label: "Descrição", get: txt("descricao") }, { label: "Parceiro", get: txt("parceiro") },
        { label: "Valor", num: true, get: (r) => `<span class="${r.tipo === "receber" ? "pos" : "neg"}">${r.tipo === "receber" ? "+" : "−"} ${BRL(r.valor)}</span>` }],
      actions: (r) => [{ label: "Conciliar manualmente", cls: "ok", fn: () => conciliar(r) }] });
}
function escolherLancamento(linha) {
  const tipo = linha.valor > 0 ? "receber" : "pagar";
  const opcoes = db.contas.filter((c) => c.tipo === tipo && !c.conciliado).sort((a, b) => diasEntre(a.vencimento, linha.data) - diasEntre(b.vencimento, linha.data)).slice(0, 15);
  if (!opcoes.length) return toast("Nenhum lançamento em aberto desse tipo");
  const lista = opcoes.map((c, i) => `${i + 1}. ${fmtDate(c.vencimento)} · ${c.descricao} · ${c.parceiro} · ${BRL(c.valor)}`).join("\n");
  const n = Number(prompt(`Vincular "${linha.descricao}" (${BRL(Math.abs(linha.valor))}) a qual lançamento?\n\n${lista}\n\nDigite o número:`));
  const c = opcoes[n - 1];
  if (!c) return;
  vincular(linha, c);
  log("Conciliação manual", `${linha.descricao} → ${c.descricao}`); render();
}

function renderFaturamento() {
  const emitidas = db.notas.filter((n) => n.status === "emitida");
  const mes = emitidas.filter((n) => monthKey(n.emissao) === monthKey(TODAY));
  const pendCont = emitidas.filter((n) => !n.contabilidade);
  const semNota = receber().filter((c) => !c.nota && c.status !== "pago");
  const aviso = asaasOn() ? "" : `<div class="panel empty">⚠️ Integração com o Asaas não configurada: as notas ficam só registradas no sistema, sem emissão na prefeitura. Veja <b>Aprovações e acessos → Configurações</b>.</div>`;
  return aviso + `<div class="kpis">
    ${kpi("Faturado no mês", BRL(sum(mes, (n) => n.valor)), `${mes.length} notas`)}
    ${kpi("Faturado (total)", BRL(sum(emitidas, (n) => n.valor)), `${emitidas.length} notas emitidas`)}
    ${kpi("Impostos estimados", BRL(sum(emitidas, (n) => n.valor) * (cfg().aliquota / 100)), `${escH(cfg().regime)} · ${String(cfg().aliquota).replace(".", ",")}%`)}
    ${kpi("Pendentes p/ contabilidade", pendCont.length, "", pendCont.length ? "neg" : "pos")}
  </div>` +
  table({ title: "Notas fiscais de serviço", rows: [...db.notas].sort((a, b) => b.numero.localeCompare(a.numero)), addCol: "notas", addDefaults: { emissao: TODAY, status: "emitida" },
    extra: `<button class="btn-ghost" data-act="${reg(() => enviarContabilidade(db.notas))}">Enviar à contabilidade</button>`,
    cols: [{ label: "Número", get: txt("numero") }, { label: "Cliente", get: txt("cliente") }, { label: "Emissão", get: date("emissao") }, { label: "Valor", get: money("valor"), num: true },
      { label: "Status", get: (r) => pill(r.status) + (r.asaas?.motivo && r.status === "erro" ? ` <span class="neg" title="${escH(r.asaas.motivo)}">ⓘ</span>` : "") },
      { label: "PDF", get: (r) => (r.asaas?.pdf ? `<a href="${escH(r.asaas.pdf)}" target="_blank" rel="noopener">abrir</a>` : "—") },
      { label: "Contabilidade", get: (r) => (r.contabilidade ? pill("enviada") : pill("pendente")) }],
    actions: (r) => [r.asaas?.id && r.status !== "emitida" && { label: "Atualizar", fn: () => sincronizar("notas", r) }, r.status === "emitida" && !r.asaas && { label: "Cancelar", cls: "no", fn: () => { r.status = "cancelada"; log("NF cancelada", `NF ${r.numero}`); render(); } }, { label: "Editar", fn: () => openForm("notas", r) }] }) +
  table({ title: "Recebíveis sem nota emitida", rows: semNota, filter: false,
    cols: [{ label: "Vencimento", get: date("vencimento") }, { label: "Cliente", get: txt("parceiro") }, { label: "Descrição", get: txt("descricao") }, { label: "Valor", get: money("valor"), num: true }],
    actions: (r) => [{ label: asaasOn() ? "Emitir NFS-e" : "Registrar NF", cls: "main", fn: () => emitirNota(r) }] });
}

function renderPropostas() {
  const abertas = db.propostas.filter((v) => ["rascunho", "enviada"].includes(v.status));
  const ganhas = db.propostas.filter((v) => ["aprovada", "pedido"].includes(v.status));
  const decididas = db.propostas.filter((v) => ["aprovada", "pedido", "perdida"].includes(v.status));
  return `<div class="kpis">
    ${kpi("Pipeline em aberto", BRL(sum(abertas, (v) => v.valor)), `${abertas.length} propostas`)}
    ${kpi("Ganhas", BRL(sum(ganhas, (v) => v.valor)), `${ganhas.length} propostas`, "pos")}
    ${kpi("Taxa de conversão", decididas.length ? Math.round((ganhas.length / decididas.length) * 100) + "%" : "—")}
  </div>` + table({ title: "Propostas e pedidos", rows: db.propostas, addCol: "propostas", addDefaults: { status: "rascunho", data: TODAY },
    cols: [{ label: "Data", get: date("data") }, { label: "Cliente", get: txt("cliente") }, { label: "Título", get: txt("titulo") }, { label: "Valor", get: money("valor"), num: true }, { label: "Status", get: (r) => pill(r.status) }],
    actions: (r) => [
      r.status === "rascunho" && { label: "Enviar", cls: "main", fn: () => { r.status = "enviada"; log("Proposta enviada", `${r.cliente}: ${r.titulo}`); render(); } },
      r.status === "enviada" && { label: "Aprovada", cls: "ok", fn: () => { r.status = "aprovada"; log("Proposta aprovada", `${r.cliente}: ${r.titulo}`); render(); } },
      r.status === "enviada" && { label: "Perdida", cls: "no", fn: () => { r.status = "perdida"; log("Proposta perdida", `${r.cliente}: ${r.titulo}`); render(); } },
      r.status === "aprovada" && { label: "Gerar pedido", cls: "main", fn: () => converterProposta(r) },
      ["rascunho", "enviada"].includes(r.status) && { label: "Follow-up", fn: () => openForm("atividades", null, { cliente: r.cliente, proposta: r.titulo, data: addDays(TODAY, 3), tipo: "Ligação", responsavel: currentUser().nome, concluida: false }) },
      ...editDel("propostas")(r)] });
}

function renderContratos() {
  const infos = db.contratos.map((k) => ({ ...k, ...contratoInfo(k) }));
  const vig = infos.filter((k) => k.status === "vigente");
  return `<div class="kpis">
    ${kpi("Contratos vigentes", vig.length)}
    ${kpi("Receita recorrente mensal", BRL(sum(vig, (k) => k.valorAtual)), "com reajustes aplicados", "pos")}
    ${kpi("Vencem em até 3 meses", vig.filter((k) => k.fim <= addMonths(TODAY, 3)).length, "avaliar renovação")}
    ${kpi("Reajustes nos próximos 60 dias", vig.filter((k) => k.reajuste > 0 && k.proxReajuste <= addMonths(TODAY, 2)).length)}
  </div>` + table({ title: "Contratos", rows: infos, addCol: "contratos", addDefaults: { inicio: TODAY, fim: addMonths(TODAY, 12), reajuste: 0, indice: "IPCA" },
    cols: [{ label: "Cliente", get: txt("cliente") }, { label: "Objeto", get: txt("objeto") }, { label: "Vigência", get: (r) => `${fmtDate(r.inicio)} → ${fmtDate(r.fim)}` },
      { label: "Parcela atual", num: true, get: (r) => BRL(r.valorAtual) }, { label: "Reajuste", get: (r) => (r.reajuste ? `${r.reajuste}% ${escH(r.indice)} · ${fmtDate(r.proxReajuste)}` : "—") },
      { label: "Parcelas", get: (r) => `${r.restantes}/${r.total} restantes` },
      { label: "Cobrança automática", get: (r) => (r.status === "vigente" ? `todo dia ${Math.min(28, Math.max(1, Number(r.diaVencimento) || 10))}` : "—") }, { label: "Status", get: (r) => pill(r.status) }],
    actions: (r) => [r.status === "vigente" && { label: "Gerar próxima agora", fn: () => gerarParcela(db.contratos.find((k) => k.id === r.id)) },
      docsAction("contratos")(r), ...editDel("contratos")(db.contratos.find((k) => k.id === r.id))] });
}

function renderServicos() {
  const ps = db.projetos.map((p) => ({ ...p, ...projetoInfo(p) }));
  const porCliente = db.clientes.map((c) => { const l = ps.filter((p) => p.cliente === c.nome); return { cliente: c.nome, receita: sum(l, (p) => p.orcamento), custo: sum(l, (p) => p.custo), horas: sum(l, (p) => p.horas) }; }).filter((x) => x.receita);
  return `<div class="kpis">
    ${kpi("Orçamento vendido", BRL(sum(ps, (p) => p.orcamento)))}
    ${kpi("Custo total", BRL(sum(ps, (p) => p.custo)))}
    ${kpi("Margem média", Math.round((sum(ps, (p) => p.margem) / Math.max(1, sum(ps, (p) => p.orcamento))) * 100) + "%", "", "pos")}
    ${kpi("Horas trabalhadas", sum(ps, (p) => p.horas).toLocaleString("pt-BR") + " h")}
  </div>` + table({ title: "Rentabilidade por projeto", rows: ps, addCol: "projetos", addDefaults: { valorHora: 140, horas: 0, custoTerceiros: 0 },
    cols: [{ label: "Projeto", get: txt("nome") }, { label: "Cliente", get: txt("cliente") }, { label: "Orçamento", get: money("orcamento"), num: true },
      { label: "Horas", get: (r) => r.horas + " h", num: true }, { label: "Custo", get: money("custo"), num: true },
      { label: "Consumo do orçamento", get: (r) => `<div class="meter" title="${Math.round(r.consumo * 100)}%"><i style="width:${Math.min(100, r.consumo * 100)}%;${r.consumo > 0.9 ? "background:#c62828" : ""}"></i></div>` },
      { label: "Margem", num: true, get: (r) => `<span class="${r.margem >= 0 ? "pos" : "neg"}">${BRL(r.margem)} (${Math.round(r.pct * 100)}%)</span>` }],
    actions: (r) => [{ label: "+ Horas", cls: "main", fn: () => { const h = Number(prompt("Horas a lançar", "8")); if (h > 0) { const p = db.projetos.find((x) => x.id === r.id); p.horas += h; log("Horas lançadas", `${p.nome}: +${h} h`); render(); } } },
      ...editDel("projetos")(db.projetos.find((x) => x.id === r.id))] }) +
  table({ title: "Rentabilidade por cliente", rows: porCliente, filter: false,
    cols: [{ label: "Cliente", get: txt("cliente") }, { label: "Receita", get: money("receita"), num: true }, { label: "Custo", get: money("custo"), num: true }, { label: "Horas", get: (r) => r.horas + " h", num: true },
      { label: "Margem", num: true, get: (r) => `<span class="${r.receita - r.custo >= 0 ? "pos" : "neg"}">${BRL(r.receita - r.custo)}</span>` }] });
}

function renderPessoas() {
  const folha = folhaMensal();
  const areas = [...new Set(db.colaboradores.map((e) => e.area))];
  return `<div class="kpis">
    ${kpi("Colaboradores", db.colaboradores.length)}
    ${kpi("Salários", BRL(sum(db.colaboradores, (e) => e.salario)))}
    ${kpi("Benefícios", BRL(sum(db.colaboradores, (e) => e.beneficios)))}
    ${kpi("Custo total da folha", BRL(folha), `com ${cfg().encargos}% de encargos`)}
  </div>` + table({ title: "Colaboradores", rows: db.colaboradores, addCol: "colaboradores", addDefaults: { admissao: TODAY, area: "Criação" },
    extra: `<button class="btn-ghost" data-act="${reg(() => exportarCSV(`folha-${monthKey(TODAY)}.csv`, ["Nome", "Cargo", "Área", "Salário", "Benefícios", "Admissão"], db.colaboradores.map((e) => [e.nome, e.cargo, e.area, e.salario.toFixed(2), e.beneficios.toFixed(2), fmtDate(e.admissao)])))}">Exportar p/ folha (CSV)</button>`,
    cols: [{ label: "Nome", get: (r) => thumb(r.fotoId, r.nome, true) }, { label: "Cargo", get: txt("cargo") }, { label: "Área", get: (r) => pill(r.area) }, { label: "Vínculo", get: (r) => escH(r.vinculo || "—") }, { label: "Admissão", get: date("admissao") },
      { label: "Salário", get: money("salario"), num: true }, { label: "Benefícios", get: money("beneficios"), num: true }, { label: "Custo mensal", num: true, get: (r) => BRL(r.salario * encargo() + r.beneficios) }],
    actions: (r) => [docsAction("colaboradores")(r), ...editDel("colaboradores")(r)] }) +
  table({ title: "Custo por área", filter: false, rows: areas.map((a) => { const l = db.colaboradores.filter((e) => e.area === a); return { area: a, n: l.length, custo: sum(l, (e) => e.salario * encargo() + e.beneficios) }; }),
    cols: [{ label: "Área", get: txt("area") }, { label: "Pessoas", get: (r) => r.n, num: true }, { label: "Custo mensal", get: money("custo"), num: true }] });
}

function renderRelatorios() {
  const pagos = db.contas.filter((c) => c.status === "pago");
  const receita = sum(pagos.filter((c) => c.tipo === "receber"), (c) => c.valor);
  const despesa = sum(pagos.filter((c) => c.tipo === "pagar"), (c) => c.valor);
  const inad = inadimplentes();
  const totalRec = sum(receber(), (c) => c.valor);
  const cats = [...new Set(db.contas.map((c) => c.categoria))];
  const porCat = cats.map((cat) => ({ cat, rec: sum(pagos.filter((c) => c.categoria === cat && c.tipo === "receber"), (c) => c.valor), desp: sum(pagos.filter((c) => c.categoria === cat && c.tipo === "pagar"), (c) => c.valor) }));
  const porCliente = db.clientes.map((c) => ({ nome: c.nome, rec: sum(pagos.filter((x) => x.tipo === "receber" && x.parceiro === c.nome), (x) => x.valor), atraso: sum(inad.filter((x) => x.parceiro === c.nome), (x) => x.valor) }));
  return `<div class="kpis">
    ${kpi("Receita realizada", BRL(receita), "", "pos")}
    ${kpi("Despesas realizadas", BRL(despesa), "", "neg")}
    ${kpi("Resultado", BRL(receita - despesa), receita ? `margem ${Math.round(((receita - despesa) / receita) * 100)}%` : "", receita - despesa >= 0 ? "pos" : "neg")}
    ${kpi("Inadimplência", totalRec ? ((sum(inad, (c) => c.valor) / totalRec) * 100).toFixed(1) + "%" : "0%", `${BRL(sum(inad, (c) => c.valor))} vencidos`, inad.length ? "neg" : "")}
  </div>
  <div class="grid-2">
    ${table({ title: "Resultado por área / categoria", filter: false, rows: porCat,
      cols: [{ label: "Categoria", get: txt("cat") }, { label: "Receitas", get: money("rec"), num: true }, { label: "Despesas", get: money("desp"), num: true },
        { label: "Resultado", num: true, get: (r) => `<span class="${r.rec - r.desp >= 0 ? "pos" : "neg"}">${BRL(r.rec - r.desp)}</span>` }] })}
    ${table({ title: "Receita e inadimplência por cliente", filter: false, rows: porCliente,
      cols: [{ label: "Cliente", get: txt("nome") }, { label: "Receita", get: money("rec"), num: true }, { label: "Em atraso", num: true, get: (r) => `<span class="${r.atraso ? "neg" : ""}">${BRL(r.atraso)}</span>` }] })}
  </div>
  <div class="panel"><div class="panel__head"><h3 class="panel__title">Receitas × despesas por mês</h3>
    <button class="btn-ghost" data-act="${reg(() => exportarCSV(`relatorio-${TODAY}.csv`, ["Mês", "Entradas", "Saídas", "Saldo"], fluxoMeses(-5, 0).map((x) => [x.key, x.ent, x.sai, x.saldo])))}">Exportar CSV</button></div>${bars(fluxoMeses(-5, 0))}</div>`;
}

function renderAprovacoes() {
  const compras = db.compras.filter((p) => ["solicitado", "cotação"].includes(p.status));
  const despesas = pagar().filter((c) => !c.aprovado);
  const aviso = canApprove() ? "" : `<div class="panel empty">Seu perfil (${PERFIS[currentUser().perfil].label}) não tem permissão para aprovar.</div>`;
  return aviso + table({ title: "Despesas aguardando aprovação", rows: despesas, filter: false,
    cols: [{ label: "Vencimento", get: date("vencimento") }, { label: "Descrição", get: txt("descricao") }, { label: "Fornecedor", get: txt("parceiro") }, { label: "Valor", get: money("valor"), num: true }],
    actions: canApprove() ? (r) => [{ label: "Aprovar", cls: "ok", fn: () => decidirDespesa(r, true) }, { label: "Recusar", cls: "no", fn: () => decidirDespesa(r, false) }] : null }) +
  table({ title: "Compras aguardando aprovação", rows: compras, filter: false,
    cols: [{ label: "Item", get: txt("item") }, { label: "Solicitante", get: txt("solicitante") }, { label: "Cotações", get: (r) => r.cotacoes, num: true }, { label: "Valor", get: money("valor"), num: true }, { label: "Status", get: (r) => pill(r.status) }],
    actions: canApprove() ? (r) => [{ label: "Aprovar", cls: "ok", fn: () => decidirCompra(r, true) }, { label: "Recusar", cls: "no", fn: () => decidirCompra(r, false) }] : null });
}

const MODULOS_PERM = ["overview", "projetos", "financeiro", "faturamento", "compras", "vendas", "contratos", "servicos", "pessoas", "relatorios", "aprovacoes", "influenciadores", "emails"];
const modulosEfetivos = (u) => u.ativo === false ? [] : u.perfil === "admin" ? MODULOS_PERM : (u.modulos?.length ? u.modulos : PERFIS[u.perfil]?.modulos || []);
function renderUsuarios() {
  const ativos = db.usuarios.filter((u) => u.ativo !== false);
  return `<div class="kpis">${kpi("Usuários ativos", ativos.length)}${kpi("Administradores", ativos.filter((u) => u.perfil === "admin").length)}${kpi("Com permissões personalizadas", db.usuarios.filter((u) => u.modulos?.length).length)}${kpi("Bloqueados", db.usuarios.length - ativos.length, "", db.usuarios.length - ativos.length ? "neg" : "")}</div>` +
  table({ title: "Usuários", rows: db.usuarios, addCol: "usuarios", addDefaults: { perfil: "colaborador", ativo: true, aprovacao: "perfil", modulos: [] },
    cols: [
      { label: "Nome", get: (r) => { const c = db.colaboradores.find((x) => x.nome === (r.colaborador || r.nome)); return thumb(c?.fotoId, r.nome, true); } },
      { label: "E-mail", get: txt("email") },
      { label: "Perfil", get: (r) => pill(PERFIS[r.perfil]?.label || r.perfil) },
      { label: "Acesso a", get: (r) => r.perfil === "admin" ? "Tudo" : `${modulosEfetivos(r).length} módulos${r.modulos?.length ? " · personalizado" : ""}` },
      { label: "Aprova", get: (r) => (r.perfil === "admin" || (r.aprovacao === "sim") || (r.aprovacao !== "nao" && PERFIS[r.perfil]?.aprova) ? "Sim" : "Não") },
      { label: "Status", get: (r) => pill(r.ativo === false ? "bloqueado" : "ativo") }],
    actions: (r) => [
      r.id !== currentUser().id && { label: r.ativo === false ? "Desbloquear" : "Bloquear", cls: r.ativo === false ? "ok" : "no", fn: () => { r.ativo = r.ativo === false; log(r.ativo ? "Usuário desbloqueado" : "Usuário bloqueado", r.email); render(); } },
      { label: "Editar", fn: () => openForm("usuarios", r) },
      r.id !== currentUser().id && { label: "Excluir", cls: "no", fn: () => { if (confirm(`Excluir o usuário ${r.email}? Prefira bloquear para manter o histórico.`)) { db.usuarios = db.usuarios.filter((x) => x.id !== r.id); log("Exclusão", `Usuário: ${r.email}`); render(); } } },
    ] }) +
  `<div class="panel empty">Dica: para quem sai da agência, use <b>Bloquear</b> em vez de excluir — o acesso é cortado na hora e o histórico continua registrado.</div>`;
}
function renderMatriz() {
  return `<div class="panel"><div class="panel__head"><h3 class="panel__title">O que cada perfil acessa por padrão</h3></div>
    <table class="table matrix"><thead><tr><th>Módulo</th>${Object.values(PERFIS).map((p) => `<th>${p.label}</th>`).join("")}</tr></thead>
    <tbody>${MODULOS_PERM.map((mod) => `<tr><td>${MODULES[mod].label}</td>${Object.values(PERFIS).map((p) => `<td>${p.modulos === "*" || p.modulos.includes(mod) ? "✓" : "—"}</td>`).join("")}</tr>`).join("")}
    <tr><td>Aprovar despesas e compras</td>${Object.values(PERFIS).map((p) => `<td>${p.aprova ? "✓" : "—"}</td>`).join("")}</tr>
    <tr><td>Usuários e acessos</td>${Object.keys(PERFIS).map((k) => `<td>${k === "admin" ? "✓" : "—"}</td>`).join("")}</tr></tbody></table>
    <p class="empty">Cada usuário pode ter módulos diferentes do padrão: edite o usuário e marque as permissões personalizadas. Dados pessoais e salários dos colaboradores só aparecem para quem tem o módulo Pessoas.</p></div>`;
}

/* ----- Concorrências (pitches) ----- */
const CAT_CUSTO = ["Criação / horas internas", "Produção", "Mídia / testes", "Pesquisa", "Viagem e deslocamento", "Fornecedor externo", "Impressão / materiais", "Outros"];
const custoTotal = (c) => sum(c.custos || [], (x) => x.valor);
function renderConcorrencias() {
  const rows = [...db.concorrencias].sort((a, b) => String(b.dataApresentacao || "").localeCompare(String(a.dataApresentacao || "")));
  const ganhas = rows.filter((c) => c.status === "ganha"), perdidas = rows.filter((c) => c.status === "perdida");
  const investido = sum(rows, custoTotal);
  const andamento = rows.filter((c) => ["em preparação", "apresentada"].includes(c.status));
  const verbaGanha = sum(ganhas, (c) => c.valorEstimado);
  return `<div class="kpis">
    ${kpi("Investido em concorrências", BRL(investido), `${rows.length} concorrências`)}
    ${kpi("Em andamento", andamento.length, BRL(sum(andamento, custoTotal)) + " gastos até agora")}
    ${kpi("Taxa de vitória", ganhas.length + perdidas.length ? Math.round((ganhas.length / (ganhas.length + perdidas.length)) * 100) + "%" : "—", `${ganhas.length} ganhas · ${perdidas.length} perdidas`, "pos")}
    ${kpi("Retorno", investido ? (verbaGanha / investido).toFixed(1).replace(".", ",") + "x" : "—", `verba anual ganha ${BRL(verbaGanha)}`)}
  </div>` + table({ title: "Concorrências", rows, addCol: "concorrencias", addDefaults: { status: "em preparação", custos: [], valorEstimado: 0, responsavel: currentUser().nome },
    cols: [{ label: "Concorrência", get: (r) => `<b>${escH(r.nome)}</b>${linksHtml(r)}` }, { label: "Cliente / prospect", get: txt("cliente") }, { label: "Status", get: (r) => pill(r.status) },
      { label: "Apresentação", get: date("dataApresentacao") }, { label: "Responsável", get: (r) => escH(r.responsavel || "—") },
      { label: "Custos", num: true, get: (r) => BRL(custoTotal(r)) }, { label: "Verba estimada", num: true, get: money("valorEstimado") }],
    actions: (r) => [
      { label: `Custos (${(r.custos || []).length})`, cls: "main", fn: () => abrirCustos(r) },
      r.status === "apresentada" && { label: "Ganhou", cls: "ok", fn: () => ganharConcorrencia(r) },
      r.status === "apresentada" && { label: "Perdeu", cls: "no", fn: () => { r.status = "perdida"; log("Concorrência perdida", r.nome); render(); } },
      r.status === "em preparação" && { label: "Apresentada", fn: () => { r.status = "apresentada"; r.dataApresentacao ||= TODAY; log("Concorrência apresentada", r.nome); render(); } },
      docsAction("concorrencias")(r), ...editDel("concorrencias")(r)] });
}
function ganharConcorrencia(r) {
  r.status = "ganha";
  if (!db.propostas.some((v) => v.titulo === r.nome)) db.propostas.push({ id: uid(), cliente: r.cliente, titulo: r.nome, valor: Number(r.valorEstimado) || 0, data: TODAY, status: "aprovada" });
  log("Concorrência ganha", `${r.nome} — proposta criada em Propostas e pedidos`);
  toast("Parabéns! Proposta criada em Propostas e pedidos"); render();
}
function abrirCustos(c) {
  c.custos ||= [];
  let dlg = document.getElementById("custoDialog");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "custoDialog"; dlg.className = "dialog dialog--wide"; document.body.appendChild(dlg); }
  const draw = () => {
    dlg.innerHTML = `<h2>Custos — ${escH(c.nome)}</h2>
      <div class="kpis">${kpi("Total gasto", BRL(custoTotal(c)))}${kpi("Lançado no financeiro", BRL(sum(c.custos.filter((x) => x.contaId), (x) => x.valor)))}</div>
      ${c.custos.length ? `<table class="table"><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Fornecedor</th><th class="num">Valor</th><th>Financeiro</th><th></th></tr></thead><tbody>
        ${c.custos.map((x, i) => `<tr><td>${fmtDate(x.data)}</td><td>${escH(x.descricao)}</td><td>${pill(x.categoria)}</td><td>${escH(x.fornecedor || "—")}</td><td class="num">${BRL(x.valor)}</td>
          <td>${x.contaId ? pill("lançado") : "—"}</td>
          <td><div class="row-actions">${!x.contaId && x.categoria !== "Criação / horas internas" ? `<button class="main" data-lancar="${i}">Lançar em contas a pagar</button>` : ""}<button class="no" data-del="${i}">Remover</button></div></td></tr>`).join("")}
      </tbody></table>` : `<p class="empty">Nenhum custo lançado.</p>`}
      <form class="form-grid" id="custoForm" style="margin-top:16px;grid-template-columns:repeat(3,1fr)">
        <label class="full">Descrição<input name="descricao" required /></label>
        <label>Categoria<select name="categoria">${CAT_CUSTO.map((x) => `<option>${x}</option>`).join("")}</select></label>
        <label>Valor<input name="valor" type="number" step="0.01" min="0" required /></label>
        <label>Data<input name="data" type="date" value="${TODAY}" required /></label>
        <label>Fornecedor<input name="fornecedor" list="custoForn" /></label>
        <datalist id="custoForn">${db.fornecedores.map((f) => `<option value="${escH(f.nome)}">`).join("")}</datalist>
        <div class="dialog__actions" style="grid-column:1/-1;margin-top:0"><button class="btn-primary" type="submit">Adicionar custo</button></div></form>
      <p class="empty">Horas internas entram no custo da concorrência, mas não viram conta a pagar. Os demais custos podem ser lançados no Financeiro na categoria "Concorrência".</p>
      <div class="dialog__actions"><button class="btn-ghost" data-close>Fechar</button></div>`;
  };
  dlg.onclick = (e) => {
    if (e.target.closest("[data-close]")) return dlg.close();
    const del = e.target.closest("[data-del]"), lanc = e.target.closest("[data-lancar]");
    if (del && confirm("Remover este custo?")) { const x = c.custos[Number(del.dataset.del)]; c.custos.splice(Number(del.dataset.del), 1); log("Custo de concorrência removido", `${c.nome}: ${x.descricao}`); render(); draw(); }
    if (lanc) {
      const x = c.custos[Number(lanc.dataset.lancar)];
      const conta = { id: uid(), tipo: "pagar", descricao: `Concorrência ${c.nome}: ${x.descricao}`, parceiro: x.fornecedor || "A definir", categoria: "Concorrência", valor: x.valor, vencimento: x.data > TODAY ? x.data : addDays(TODAY, 7), status: "aberto", conciliado: false, aprovado: canApprove() || x.valor < 5000 };
      db.contas.push(conta); x.contaId = conta.id;
      log("Custo lançado no financeiro", `${c.nome}: ${x.descricao} — ${BRL(x.valor)}`); toast(conta.aprovado ? "Lançado em Contas a pagar" : "Lançado em Contas a pagar — aguardando aprovação"); render(); draw();
    }
  };
  dlg.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    c.custos.push({ descricao: String(fd.get("descricao")).trim(), categoria: fd.get("categoria"), valor: Number(fd.get("valor")) || 0, data: fd.get("data"), fornecedor: String(fd.get("fornecedor") || "").trim() });
    log("Custo de concorrência", `${c.nome}: ${fd.get("descricao")} — ${BRL(fd.get("valor"))}`); render(); draw();
  };
  draw(); dlg.showModal();
}

/* ----- Caixa de e-mails (automação) ----- */
const TIPO_EMAIL = { nota_fiscal: "Nota fiscal", boleto: "Boleto", contrato: "Contrato", comprovante_pagamento: "Comprovante", orcamento: "Orçamento", cobranca: "Cobrança", outro: "Outro" };
const emailsNovos = () => (db?.emails || []).filter((e) => e.status === "novo").length;
const podeLancarConta = () => ["financeiro", "aprovacoes", "contratos"].some(can);
const filtroEmail = { area: "todas", status: "novo" };
function lancarEmail(e) {
  const influ = e.entidade?.col === "influenciadores";
  const conta = { id: uid(), tipo: "pagar", descricao: `${TIPO_EMAIL[e.tipo] || "Documento"}${e.numero ? " " + e.numero : ""} — ${e.entidade?.nome || e.emitente || e.de}${e.campanha ? ` (${e.campanha})` : ""}`.slice(0, 160),
    parceiro: e.entidade?.nome || e.emitente || "A definir", categoria: influ ? "Influenciadores" : e.entidade?.col === "fornecedores" ? (db.fornecedores.find((f) => f.id === e.entidade.id)?.categoria || "Outros") : "Outros",
    valor: e.valor, vencimento: e.vencimento || addDays(TODAY, 7), status: "aberto", conciliado: false, aprovado: canApprove() || e.valor < 5000, nota: e.tipo === "nota_fiscal" ? e.numero : "", origemEmail: e.id };
  if (!SCHEMAS.contas.fields[3].options.includes(conta.categoria)) conta.categoria = "Outros";
  db.contas.push(conta);
  e.status = "lançado"; e.contaId = conta.id;
  // NF de influenciador: marca o contrato em aberto dele como "NF recebida".
  if (influ && e.tipo === "nota_fiscal") {
    const k = db.influContratos.find((x) => x.influenciador === e.entidade.nome && !x.nfRecebida && x.status !== "cancelado");
    if (k) { k.nfRecebida = true; k.contaId ||= conta.id; e.vinculo = k.campanha; }
  }
  log("Lançado a partir de e-mail", `${conta.descricao} — ${BRL(conta.valor)}`);
  toast(conta.aprovado ? "Lançado em Contas a pagar" : "Lançado em Contas a pagar — aguardando aprovação"); render();
}
async function sincronizarEmails() {
  try { toast("Lendo as caixas de e-mail…"); const r = await apiAction("/api/emails/sincronizar", {}); toast(r.novos ? `${r.novos} documento(s) novo(s)` : r.erros?.length ? r.erros[0] : "Nenhum documento novo"); }
  catch (e) { toast(e.message); }
}
function renderEmails() {
  const st = db.integracoes?.emails || {};
  const todos = db.emails || [];
  const rows = todos.filter((e) => (filtroEmail.area === "todas" || e.area === filtroEmail.area) && (filtroEmail.status === "todos" || e.status === filtroEmail.status));
  const novos = todos.filter((e) => e.status === "novo");
  const pagar = novos.filter((e) => e.direcao === "a_pagar" && e.valor > 0);
  const semDono = novos.filter((e) => !e.entidade);
  const sel = (id, val, opcoes) => `<select class="filter-input" data-emailf="${id}">${Object.entries(opcoes).map(([k, l]) => `<option value="${k}" ${val === k ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  const extra = sel("area", filtroEmail.area, { todas: "Todas as caixas", financeiro: "financeiro@", influenciadores: "influenciadores@" }) +
    sel("status", filtroEmail.status, { novo: "Novos", "lançado": "Lançados", arquivado: "Arquivados", todos: "Todos" }) +
    (st.google && st.ia ? `<button class="btn-primary" data-act="${reg(sincronizarEmails)}">Ler e-mails agora</button>` : "");
  const aviso = !(st.google && st.ia) ? `<div class="panel"><div class="panel__head"><h3 class="panel__title">Automação ainda não conectada</h3>${pill("pendente")}</div>
    <p class="empty">Faltam: ${[!st.google && "conta de serviço do Google Workspace", !st.ia && "chave da IA (ANTHROPIC_API_KEY)", !st.drive && "pasta raiz do Drive"].filter(Boolean).join(", ")}. O passo a passo está em Aprovações e configurações → Configurações. Abaixo, exemplos de como os documentos vão aparecer.</p></div>`
    : st.erros?.length ? `<div class="panel"><p class="empty">Última leitura com avisos: ${escH(st.erros.join(" · "))}</p></div>` : "";
  return aviso + `<div class="kpis">
    ${kpi("Documentos novos", novos.length, st.ultimaSync ? `última leitura ${new Date(st.ultimaSync).toLocaleString("pt-BR")}` : "", novos.length ? "" : "pos")}
    ${kpi("A pagar vindos por e-mail", BRL(sum(pagar, (e) => e.valor)), `${pagar.length} documentos não lançados`)}
    ${kpi("Notas fiscais novas", novos.filter((e) => e.tipo === "nota_fiscal").length)}
    ${kpi("Sem cadastro identificado", semDono.length, "cadastre o fornecedor ou influenciador", semDono.length ? "neg" : "")}
  </div>` + table({ title: "Caixa de e-mails", rows, extra,
    cols: [{ label: "Recebido", get: (r) => new Date(r.data).toLocaleDateString("pt-BR") },
      { label: "Caixa", get: (r) => pill(r.area === "influenciadores" ? "influenciadores@" : "financeiro@") },
      { label: "Documento", get: (r) => `${pill(TIPO_EMAIL[r.tipo] || r.tipo)}<div><b>${escH(r.assunto)}</b></div><div class="crumbs">${escH(r.resumo || "")}</div>` },
      { label: "De / cadastro", get: (r) => (r.entidade ? `<b>${escH(r.entidade.nome)}</b>` : `<span class="neg">não identificado</span>`) + `<div class="crumbs">${escH(r.de)}</div>` },
      { label: "Valor", num: true, get: (r) => (r.valor ? BRL(r.valor) : "—") },
      { label: "Vencimento", get: (r) => (r.vencimento ? fmtDate(r.vencimento) : "—") },
      { label: "Arquivos", get: (r) => (r.anexos || []).map((a) => `<div>${a.arqId ? `<a href="${fileUrl(a.arqId)}" target="_blank" rel="noopener">${escH(a.nome)}</a>` : escH(a.nome)}${a.drive ? ` · <a href="${escH(a.drive)}" target="_blank" rel="noopener">Drive</a>` : ""}</div>`).join("") + (r.drivePasta ? `<a class="link-chip" href="${escH(r.drivePasta)}" target="_blank" rel="noopener">📁 pasta</a>` : "") || "—" },
      { label: "Status", get: (r) => pill(r.status) + (r.vinculo ? `<div class="crumbs">${escH(r.vinculo)}</div>` : "") }],
    actions: (r) => [
      r.status === "novo" && r.direcao === "a_pagar" && r.valor > 0 && podeLancarConta() && { label: "Lançar em contas a pagar", cls: "ok", fn: () => lancarEmail(r) },
      r.contaId && { label: "Ver lançamento", fn: () => { state2.mod = "financeiro"; state2.tab.financeiro = "Contas a pagar"; tableFilters["Contas a pagar"] = (db.contas.find((c) => c.id === r.contaId)?.descricao || "").slice(0, 30); render(); } },
      r.status === "novo" && { label: "Arquivar", fn: () => { r.status = "arquivado"; log("E-mail arquivado", r.assunto); render(); } },
      r.status === "arquivado" && { label: "Reabrir", fn: () => { r.status = "novo"; render(); } },
      !r.entidade && r.documento && { label: "Cadastrar fornecedor", fn: () => openForm(r.area === "influenciadores" ? "influenciadores" : "fornecedores", null, r.area === "influenciadores" ? { nome: r.emitente, cpfCnpj: r.documento, rede: "Instagram", seguidores: 0 } : { nome: r.emitente, cnpj: r.documento, categoria: "Outros" }) },
    ] });
}

/* ----- Influenciadores ----- */
const influContaStatus = (k) => { const c = k.contaId && db.contas.find((x) => x.id === k.contaId); return c ? contaStatus(c) : "—"; };
function lancarCache(k) {
  const conta = { id: uid(), tipo: "pagar", descricao: `Cachê ${k.influenciador} — ${k.campanha}`, parceiro: k.influenciador, categoria: "Influenciadores", valor: k.valor, vencimento: k.vencimentoPagamento || addDays(TODAY, 15), status: "aberto", conciliado: false, aprovado: canApprove() || k.valor < 5000 };
  db.contas.push(conta); k.contaId = conta.id;
  log("Cachê lançado", `${conta.descricao} — ${BRL(conta.valor)}`); toast(conta.aprovado ? "Lançado em Contas a pagar" : "Lançado — aguardando aprovação"); render();
}
function renderInfluContratos() {
  const rows = [...db.influContratos].sort((a, b) => String(a.vencimentoPagamento || "").localeCompare(String(b.vencimentoPagamento || "")));
  const ativos = rows.filter((k) => !["pago", "cancelado"].includes(k.status));
  const semNf = ativos.filter((k) => !k.nfRecebida && ["publicado", "assinado"].includes(k.status));
  return `<div class="kpis">
    ${kpi("Cachês em aberto", BRL(sum(ativos, (k) => k.valor)), `${ativos.length} contratos`)}
    ${kpi("Aguardando NF", semNf.length, "publicados ou assinados sem nota", semNf.length ? "neg" : "pos")}
    ${kpi("Pagos no ano", BRL(sum(rows.filter((k) => k.status === "pago"), (k) => k.valor)))}
    ${kpi("Documentos novos no e-mail", (db.emails || []).filter((e) => e.area === "influenciadores" && e.status === "novo").length, "influenciadores@")}
  </div>` + table({ title: "Contratos de influenciadores", rows, addCol: "influContratos", addDefaults: { status: "negociação", nfRecebida: false, valor: 0 },
    cols: [{ label: "Influenciador", get: (r) => `<b>${escH(r.influenciador)}</b>${linksHtml(r)}` }, { label: "Cliente / campanha", get: (r) => `${escH(r.cliente)}<div class="crumbs">${escH(r.campanha)}</div>` },
      { label: "Entregáveis", get: txt("entregaveis") }, { label: "Publicação", get: date("dataPublicacao") }, { label: "Cachê", num: true, get: money("valor") },
      { label: "Vencimento", get: date("vencimentoPagamento") }, { label: "NF", get: (r) => pill(r.nfRecebida ? "recebida" : "pendente") }, { label: "Status", get: (r) => pill(r.status) }, { label: "Pagamento", get: (r) => (r.contaId ? pill(influContaStatus(r)) : "—") }],
    actions: (r) => [
      !r.contaId && r.status !== "cancelado" && podeLancarConta() && { label: "Lançar pagamento", cls: "main", fn: () => lancarCache(r) },
      docsAction("influContratos")(r), ...editDel("influContratos")(r)] });
}
function renderInfluenciadores() {
  return table({ title: "Influenciadores", rows: db.influenciadores, addCol: "influenciadores", addDefaults: { rede: "Instagram", seguidores: 0 },
    cols: [{ label: "Influenciador", get: (r) => thumb(r.fotoId, r.nome, true) }, { label: "@", get: txt("arroba") }, { label: "Rede", get: (r) => pill(r.rede) },
      { label: "Seguidores", num: true, get: (r) => (Number(r.seguidores) || 0).toLocaleString("pt-BR") }, { label: "Nicho", get: (r) => escH(r.nicho || "—") }, { label: "E-mail", get: (r) => escH(r.email || "—") },
      { label: "Campanhas", num: true, get: (r) => db.influContratos.filter((k) => k.influenciador === r.nome).length },
      { label: "Total contratado", num: true, get: (r) => BRL(sum(db.influContratos.filter((k) => k.influenciador === r.nome && k.status !== "cancelado"), (k) => k.valor)) }],
    actions: (r) => [docsAction("influenciadores")(r), ...editDel("influenciadores")(r)] });
}

/* ----- Mídia e repasses ----- */
const midiaCalc = (m) => { const bruto = Number(m.valorBruto) || 0, com = bruto * (Number(m.comissao) || 0) / 100; return { bruto, com, repasse: bruto - com, bv: bruto * (Number(m.bv) || 0) / 100 }; };
const contaDe = (id) => id && db.contas.find((c) => c.id === id);
function lancarMidia(m, tipo) {
  const v = midiaCalc(m);
  const base = { id: uid(), status: "aberto", conciliado: false };
  let conta;
  if (tipo === "cliente") { conta = { ...base, tipo: "receber", descricao: `Mídia ${m.veiculo} — ${m.campanha}`, parceiro: m.cliente, categoria: "Mídia", valor: v.bruto, vencimento: m.vencimentoCliente || addDays(TODAY, 15), aprovado: true }; m.contaReceberId = conta.id; if (["planejado", "veiculado"].includes(m.status)) m.status = "faturado"; }
  if (tipo === "repasse") { conta = { ...base, tipo: "pagar", descricao: `Repasse de mídia ${m.veiculo} — ${m.campanha} (${m.cliente})`, parceiro: m.veiculo, categoria: "Repasse de mídia", valor: v.repasse, vencimento: m.vencimentoVeiculo || addDays(TODAY, 30), aprovado: canApprove() || v.repasse < 5000 }; m.contaPagarId = conta.id; }
  if (tipo === "bv") { conta = { ...base, tipo: "receber", descricao: `BV ${m.veiculo} — ${m.campanha}`, parceiro: m.veiculo, categoria: "BV", valor: v.bv, vencimento: addDays(m.vencimentoVeiculo || TODAY, 30), aprovado: true }; m.contaBvId = conta.id; }
  db.contas.push(conta);
  log("Mídia lançada no financeiro", `${conta.descricao} — ${BRL(conta.valor)}`); toast(conta.aprovado ? "Lançado no financeiro" : "Lançado — aguardando aprovação"); render();
}
function renderMidias() {
  const rows = [...db.midias].filter((m) => m.status !== "cancelado").sort((a, b) => String(b.competencia).localeCompare(String(a.competencia)));
  const doMes = rows.filter((m) => monthKey(m.competencia || "") === monthKey(TODAY));
  // Risco de caixa: cliente já pagou a mídia, mas o repasse ao veículo ainda não saiu.
  const repassar = rows.filter((m) => contaDe(m.contaReceberId)?.status === "pago" && contaDe(m.contaPagarId)?.status !== "pago");
  const bvAberto = rows.filter((m) => contaDe(m.contaBvId) && contaDe(m.contaBvId).status !== "pago");
  return `<div class="kpis">
    ${kpi("Verba de mídia no mês", BRL(sum(doMes, (m) => midiaCalc(m).bruto)), `${doMes.length} veiculações`)}
    ${kpi("Comissão da agência no mês", BRL(sum(doMes, (m) => midiaCalc(m).com)), "receita própria da Mantra", "pos")}
    ${kpi("Repasses a fazer", BRL(sum(repassar, (m) => midiaCalc(m).repasse)), `${repassar.length} com cliente já pago — dinheiro de terceiros em caixa`, repassar.length ? "neg" : "")}
    ${kpi("BV a receber", BRL(sum(bvAberto, (m) => midiaCalc(m).bv)), `${bvAberto.length} lançamentos`)}
  </div>
  <p class="empty" style="margin:0 0 12px">A verba do cliente passa pela Mantra, mas não é receita: o que fica é a comissão (e o BV). O faturamento ao cliente entra em Contas a receber e o repasse ao veículo em Contas a pagar, na categoria "Repasse de mídia"; a DRE desconta os repasses da receita bruta.</p>` +
  table({ title: "Veiculações e repasses", rows, addCol: "midias", addDefaults: { competencia: TODAY, comissao: 20, bv: 0, status: "planejado", valorBruto: 0 },
    cols: [{ label: "Mês", get: (r) => (r.competencia ? monthLabel(monthKey(r.competencia)) : "—") }, { label: "Cliente / campanha", get: (r) => `<b>${escH(r.cliente)}</b><div class="crumbs">${escH(r.campanha)}</div>` }, { label: "Veículo", get: txt("veiculo") },
      { label: "Bruto", num: true, get: (r) => BRL(midiaCalc(r).bruto) }, { label: "Comissão", num: true, get: (r) => `${BRL(midiaCalc(r).com)}<div class="crumbs">${Number(r.comissao) || 0}%</div>` },
      { label: "Repasse", num: true, get: (r) => BRL(midiaCalc(r).repasse) }, { label: "BV", num: true, get: (r) => (midiaCalc(r).bv ? BRL(midiaCalc(r).bv) : "—") },
      { label: "Cliente", get: (r) => (contaDe(r.contaReceberId) ? pill(contaStatus(contaDe(r.contaReceberId))) : "—") }, { label: "Veículo", get: (r) => (contaDe(r.contaPagarId) ? pill(contaStatus(contaDe(r.contaPagarId))) : "—") }, { label: "Status", get: (r) => pill(r.status) }],
    actions: (r) => [
      !r.contaReceberId && { label: "Faturar cliente", cls: "main", fn: () => lancarMidia(r, "cliente") },
      !r.contaPagarId && { label: "Lançar repasse", fn: () => lancarMidia(r, "repasse") },
      !r.contaBvId && midiaCalc(r).bv > 0 && { label: "Lançar BV", fn: () => lancarMidia(r, "bv") },
      contaDe(r.contaPagarId)?.status === "pago" && r.status !== "repassado" && { label: "Concluir", cls: "ok", fn: () => { r.status = "repassado"; render(); } },
      ...editDel("midias")(r)] });
}

/* ----- DRE, orçado × realizado e rentabilidade ----- */
const CAT_CUSTO_DIRETO = ["Produção", "Mídia", "Influenciadores", "Concorrência"];
const CAT_DESP_OPER = ["Software", "Estrutura", "Outros"];
let anoRel = Number(TODAY.slice(0, 4));
const selAno = () => { const anos = [...new Set([anoRel, Number(TODAY.slice(0, 4)), ...db.contas.map((c) => Number(String(c.vencimento).slice(0, 4)))].filter(Boolean))].sort(); return `<select class="filter-input" data-anorel>${anos.map((a) => `<option ${a === anoRel ? "selected" : ""}>${a}</option>`).join("")}</select>`; };
const folhaVisivel = () => db.colaboradores.some((e) => "salario" in e);
// Linhas da DRE de um mês (regime de competência pelo vencimento).
function dreMes(key) {
  const doMes = db.contas.filter((c) => monthKey(c.vencimento || "") === key);
  const rec = (cat) => sum(doMes.filter((c) => c.tipo === "receber" && (!cat || cat(c.categoria))), (c) => c.valor);
  const desp = (cats) => sum(doMes.filter((c) => c.tipo === "pagar" && cats.includes(c.categoria)), (c) => c.valor);
  const bruta = rec();
  const repasses = desp(["Repasse de mídia"]);
  const impostosPagos = desp(["Impostos"]);
  const impostos = impostosPagos || (bruta - repasses) * (Number(cfg().aliquota) || 0) / 100;
  const liquida = bruta - repasses - impostos;
  const diretos = desp(CAT_CUSTO_DIRETO);
  const margem = liquida - diretos;
  const pessoalLanc = desp(["Pessoal"]);
  // Folha estimada só em meses com movimento (evita "prejuízo" em meses sem nenhum lançamento).
  const pessoal = pessoalLanc || (folhaVisivel() && key <= monthKey(TODAY) && doMes.length ? folhaMensal() : 0);
  const oper = desp(CAT_DESP_OPER);
  return { bruta, repasses, impostos, impEst: !impostosPagos && bruta > 0, liquida, diretos, margem, pessoal, pesEst: !pessoalLanc && pessoal > 0, oper, resultado: margem - pessoal - oper };
}
function renderDRE() {
  const meses = Array.from({ length: 12 }, (_, i) => `${anoRel}-${String(i + 1).padStart(2, "0")}`);
  const d = meses.map(dreMes);
  const tot = Object.fromEntries(Object.keys(d[0]).map((k) => [k, sum(d, (x) => x[k])]));
  const linhas = [
    ["Receita bruta", "bruta"], ["(−) Repasses de mídia", "repasses", -1], ["(−) Impostos sobre faturamento", "impostos", -1, "impEst"], ["= Receita líquida", "liquida", 0, null, true],
    ["(−) Custos diretos (produção, mídia própria, influenciadores, concorrências)", "diretos", -1], ["= Margem de contribuição", "margem", 0, null, true],
    ["(−) Pessoal", "pessoal", -1, "pesEst"], ["(−) Despesas operacionais (software, estrutura, outros)", "oper", -1], ["= Resultado operacional", "resultado", 0, null, true],
  ];
  const cel = (v, sinal, est) => `<td class="num ${sinal ? "" : v >= 0 ? "pos" : "neg"}">${v ? (sinal || v < 0 ? "−" : "") + Math.round(Math.abs(v)).toLocaleString("pt-BR") : "—"}${est ? "<sup>*</sup>" : ""}</td>`;
  const mgem = tot.bruta - tot.repasses ? tot.resultado / (tot.bruta - tot.repasses) : 0;
  return `<div class="kpis">
    ${kpi(`Receita líquida ${anoRel}`, BRL(tot.liquida), `bruta ${BRL(tot.bruta)}`)}
    ${kpi("Margem de contribuição", BRL(tot.margem), tot.liquida ? `${Math.round((tot.margem / tot.liquida) * 100)}% da receita líquida` : "", tot.margem >= 0 ? "pos" : "neg")}
    ${kpi("Resultado operacional", BRL(tot.resultado), `margem ${Math.round(mgem * 100)}% sobre a receita de agência`, tot.resultado >= 0 ? "pos" : "neg")}
  </div>
  <div class="panel"><div class="panel__head"><h3 class="panel__title">DRE gerencial ${anoRel}</h3><div style="display:flex;gap:8px">${selAno()}
    <button class="btn-ghost" data-act="${reg(() => exportarCSV(`dre-${anoRel}.csv`, ["Linha", ...meses, "Total"], linhas.map(([l, k, sg]) => [l, ...d.map((x) => (sg ? -x[k] : x[k]).toFixed(2)), (sg ? -tot[k] : tot[k]).toFixed(2)])))}">Exportar CSV</button></div></div>
    <table class="table table--dre"><thead><tr><th>R$ (sem centavos)</th>${meses.map((m) => `<th class="num">${new Date(m + "-15T12:00:00").toLocaleDateString("pt-BR", { month: "short" }).replace(".", "")}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>
      ${linhas.map(([l, k, sg, est, forte]) => `<tr class="${forte ? "dre-total" : ""}"><td>${l}</td>${d.map((x) => cel(x[k], sg, est && x[est])).join("")}${cel(tot[k], sg)}</tr>`).join("")}
    </tbody></table>
    <p class="empty">Regime de competência pelo vencimento dos lançamentos. <sup>*</sup> Estimado: impostos pela alíquota de Configurações quando não há lançamento na categoria "Impostos"; pessoal pelo custo da folha quando não há lançamento na categoria "Pessoal".</p></div>`;
}
function realizadoCat(tipo, cat, keys) { return sum(db.contas.filter((c) => c.tipo === (tipo === "receita" ? "receber" : "pagar") && c.categoria === cat && keys.includes(monthKey(c.vencimento || ""))), (c) => c.valor); }
let mesOrc = monthKey(TODAY);
function renderOrcado() {
  const ano = Number(mesOrc.slice(0, 4));
  const linhas = db.orcamentos.filter((o) => Number(o.ano) === ano);
  const ateMes = Array.from({ length: Number(mesOrc.slice(5)) }, (_, i) => `${ano}-${String(i + 1).padStart(2, "0")}`);
  const rows = linhas.map((o) => { const orcM = Number(o.mensal) || 0, realM = realizadoCat(o.tipo, o.categoria, [mesOrc]), orcA = orcM * ateMes.length, realA = realizadoCat(o.tipo, o.categoria, ateMes); return { ...o, orcM, realM, orcA, realA }; });
  const desvio = (r, o, real) => { const dif = real - o; const bom = r.tipo === "receita" ? dif >= 0 : dif <= 0; return `<span class="${bom ? "pos" : "neg"}">${dif >= 0 ? "+" : "−"}${BRL(Math.abs(dif))}${o ? ` (${Math.round((real / o) * 100)}%)` : ""}</span>`; };
  const totR = rows.filter((r) => r.tipo === "receita"), totD = rows.filter((r) => r.tipo === "despesa");
  return `<div class="kpis">
    ${kpi("Receita orçada até o mês", BRL(sum(totR, (r) => r.orcA)), `realizado ${BRL(sum(totR, (r) => r.realA))}`)}
    ${kpi("Despesa orçada até o mês", BRL(sum(totD, (r) => r.orcA)), `realizado ${BRL(sum(totD, (r) => r.realA))}`)}
    ${kpi("Resultado orçado × realizado", BRL(sum(totR, (r) => r.realA) - sum(totD, (r) => r.realA)), `orçado ${BRL(sum(totR, (r) => r.orcA) - sum(totD, (r) => r.orcA))}`)}
  </div>` + table({ title: `Orçado × realizado — ${monthLabel(mesOrc)}`, rows, addCol: "orcamentos", addDefaults: { ano, tipo: "despesa", categoria: "Software", mensal: 0 },
    extra: `<input type="month" class="filter-input" data-mesorc value="${mesOrc}" />`,
    cols: [{ label: "Tipo", get: (r) => pill(r.tipo) }, { label: "Categoria", get: txt("categoria") },
      { label: "Orçado no mês", num: true, get: money("orcM") }, { label: "Realizado no mês", num: true, get: money("realM") }, { label: "Desvio no mês", num: true, get: (r) => desvio(r, r.orcM, r.realM) },
      { label: "Orçado no ano", num: true, get: money("orcA") }, { label: "Realizado no ano", num: true, get: money("realA") }, { label: "Desvio no ano", num: true, get: (r) => desvio(r, r.orcA, r.realA) }],
    actions: (r) => editDel("orcamentos")(db.orcamentos.find((o) => o.id === r.id)) });
}
function renderPorCliente() {
  const ano = String(anoRel);
  const noAno = (d) => String(d || "").startsWith(ano);
  const rows = db.clientes.map((c) => {
    const rec = sum(receber().filter((x) => x.parceiro === c.nome && noAno(x.vencimento) && x.categoria !== "Mídia"), (x) => x.valor);
    const midia = db.midias.filter((m) => m.cliente === c.nome && noAno(m.competencia) && m.status !== "cancelado");
    const comissao = sum(midia, (m) => midiaCalc(m).com);
    const projetos = db.projetos.filter((p) => p.cliente === c.nome);
    const custoProj = sum(projetos, (p) => projetoInfo(p).custo);
    const influ = sum(db.influContratos.filter((k) => k.cliente === c.nome && k.status !== "cancelado" && noAno(k.vencimentoPagamento || k.dataPublicacao || TODAY)), (k) => k.valor);
    const receita = rec + comissao;
    const impostos = rec * (Number(cfg().aliquota) || 0) / 100;
    const resultado = receita - impostos - custoProj - influ;
    return { nome: c.nome, logoId: c.logoId, rec, comissao, receita, impostos, custoProj, influ, resultado, margem: receita ? resultado / receita : 0 };
  }).filter((r) => r.receita || r.custoProj || r.influ).sort((a, b) => b.resultado - a.resultado);
  const total = sum(rows, (r) => r.receita);
  return `<div class="kpis">${kpi(`Receita de agência ${ano}`, BRL(total), `${rows.length} clientes`)}
    ${kpi("Resultado dos clientes", BRL(sum(rows, (r) => r.resultado)), "antes de pessoal e despesas fixas", "pos")}
    ${kpi("Maior cliente", rows.length ? escH([...rows].sort((a, b) => b.receita - a.receita)[0].nome) : "—", rows.length && total ? `${Math.round(([...rows].sort((a, b) => b.receita - a.receita)[0].receita / total) * 100)}% da receita (concentração)` : "")}</div>` +
    `<div style="display:flex;justify-content:flex-end;margin-bottom:8px">${selAno()}</div>` +
    table({ title: `Rentabilidade por cliente — ${ano}`, rows,
      cols: [{ label: "Cliente", get: (r) => thumb(r.logoId, r.nome) }, { label: "Fees e projetos", num: true, get: money("rec") }, { label: "Comissão de mídia", num: true, get: money("comissao") },
        { label: "Impostos (est.)", num: true, get: (r) => "−" + BRL(r.impostos) }, { label: "Custos de projetos", num: true, get: (r) => "−" + BRL(r.custoProj) }, { label: "Influenciadores", num: true, get: (r) => "−" + BRL(r.influ) },
        { label: "Resultado", num: true, get: (r) => `<b class="${r.resultado >= 0 ? "pos" : "neg"}">${BRL(r.resultado)}</b>` }, { label: "Margem", num: true, get: (r) => `${Math.round(r.margem * 100)}%` },
        { label: "Participação", num: true, get: (r) => (total ? `${Math.round((r.receita / total) * 100)}%` : "—") }] }) +
    `<p class="empty">Receita de agência = fees e projetos faturados + comissão de mídia (a verba bruta de mídia é repassada e não conta). Custos de projetos vêm de Projetos e serviços (horas × custo/hora + terceiros); influenciadores, dos contratos do módulo Influenciadores.</p>`;
}

/* ----- Notificações (app e navegador) ----- */
const chaveVistas = () => `mantra-notif-vistas-${me?.id}`;
const lerVistas = () => { try { return localStorage.getItem(chaveVistas()) || ""; } catch { return ""; } };
const gravarVistas = (v) => { try { localStorage.setItem(chaveVistas(), v); } catch { /* sem armazenamento local */ } };
const notifNaoLidas = () => (db?.notificacoes || []).filter((n) => n.data > lerVistas()).length;
let notifAvisadas = null; // notificações já mostradas no navegador nesta sessão
function avisarNavegador(lista) {
  if (notifAvisadas === null) { notifAvisadas = new Set(lista.map((n) => n.id)); return; }
  const novas = lista.filter((n) => !notifAvisadas.has(n.id));
  novas.forEach((n) => notifAvisadas.add(n.id));
  if (!novas.length) return;
  if ("Notification" in window && Notification.permission === "granted") {
    for (const n of novas.slice(0, 3)) {
      const aviso = new Notification(n.titulo, { body: n.texto.replace(/^\s*•\s*/gm, "• "), icon: "/logo.svg", tag: n.id });
      aviso.onclick = () => { window.focus(); if (n.modulo && can(n.modulo)) { state2.mod = n.modulo; render(); } aviso.close(); };
    }
  } else toast(novas[0].titulo);
}
async function buscarNotificacoes() {
  if (!db || !me) return;
  try { db.notificacoes = await apiFetch("/api/notificacoes"); avisarNavegador(db.notificacoes); renderRail(); } catch { /* tenta de novo no próximo ciclo */ }
}
setInterval(() => { if (document.visibilityState === "visible" || "Notification" in window) buscarNotificacoes(); }, 120000);
async function ativarNavegador() {
  if (!("Notification" in window)) return toast("Este navegador não suporta notificações");
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "Notificações do navegador ativadas" : "Permissão negada. Libere nas configurações do site, no cadeado da barra de endereço.");
  if (p === "granted") new Notification("Mantra ERP", { body: "Pronto! Você vai ser avisado por aqui.", icon: "/logo.svg" });
}
function abrirNotificacoes() {
  let dlg = document.getElementById("notifDialog");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "notifDialog"; dlg.className = "dialog"; document.body.appendChild(dlg); }
  const vistas = lerVistas();
  const lista = db.notificacoes || [];
  const permissao = "Notification" in window ? Notification.permission : "indisponível";
  dlg.innerHTML = `<h2>Notificações</h2>
    ${permissao !== "granted" && permissao !== "indisponível" ? `<p class="empty">Receba os avisos também no navegador. <button class="btn-mini" data-ativar>Ativar no navegador</button></p>` : ""}
    ${lista.length ? `<div class="notif-lista">${lista.map((n) => `<button class="notif ${n.data > vistas ? "is-nova" : ""}" data-mod="${escH(n.modulo || "")}">
      <b>${escH(n.titulo)}</b><span class="crumbs">${new Date(n.data).toLocaleString("pt-BR")}</span>${n.texto ? `<span class="notif__texto">${escH(n.texto)}</span>` : ""}</button>`).join("")}</div>` : `<p class="empty">Nenhuma notificação por enquanto.</p>`}
    <div class="dialog__actions"><button class="btn-ghost" data-close>Fechar</button></div>`;
  dlg.onclick = (e) => {
    if (e.target.closest("[data-ativar]")) return ativarNavegador().then(() => abrirNotificacoes());
    if (e.target.closest("[data-close]")) return dlg.close();
    const n = e.target.closest(".notif");
    if (n?.dataset.mod && can(n.dataset.mod)) { state2.mod = n.dataset.mod; dlg.close(); render(); }
  };
  dlg.onclose = () => renderRail();
  if (lista[0]) gravarVistas(lista[0].data);
  dlg.showModal();
}

/* ----- Custos das APIs (tokens) ----- */
function renderArmazenamento() {
  const a = db.integracoes?.armazenamento;
  if (!a) return "";
  const banco = a.resumo.find((x) => x.onde === "banco") || { n: 0, bytes: 0 }, drive = a.resumo.find((x) => x.onde === "drive") || { n: 0, bytes: 0 };
  const mover = reg(async () => {
    try {
      let r; do { toast("Movendo documentos para o Drive…"); r = await apiFetch("/api/arquivos/migrar", {}); } while (r.restantes && r.movidos);
      toast(`Documentos no Drive. ${r.restantes ? "Ainda há arquivos; clique de novo." : "Concluído."}`); await loadData(); renderView();
    } catch (e) { toast(e.message); }
  });
  const bkDrive = reg(async () => { try { const r = await apiFetch("/api/backup/drive", {}); toast(`Backup salvo no Drive: ${r.nome}`); await loadData(); renderView(); } catch (e) { toast(e.message); } });
  return `<div class="panel"><div class="panel__head"><h3 class="panel__title">Arquivos e backup</h3>${db.integracoes.drive ? pill("Google Drive").replace("pill--", "pill--green ") : pill("guardando no banco")}</div>
    <div class="kpis">${kpi("No Google Drive", drive.n, fmtBytes(drive.bytes))}${kpi("No banco de dados", banco.n, fmtBytes(banco.bytes) + " (logos e fotos ficam sempre aqui)", banco.bytes > 200 * 1048576 ? "neg" : "")}${kpi("Último backup automático", a.backup.ultimo ? new Date(a.backup.ultimo).toLocaleString("pt-BR") : "nenhum", a.backup.ultimo ? "pasta Backups do ERP no Drive" : "precisa do Drive configurado")}</div>
    <p class="empty">Com o Drive configurado, documentos novos vão para "Arquivos do ERP/&lt;cadastro&gt;/&lt;nome&gt;" e o banco guarda só a referência. Todo dia às 8h sai um backup completo (JSON) para "Backups do ERP".</p>
    <div class="dialog__actions" style="justify-content:flex-start">
      <a class="btn-ghost" href="/api/backup" download>Baixar backup agora</a>
      ${db.integracoes.drive ? `<button class="btn-ghost" data-act="${bkDrive}">Salvar backup no Drive</button>${banco.n ? `<button class="btn-primary" data-act="${mover}">Mover documentos do banco para o Drive</button>` : ""}` : ""}
    </div></div>`;
}
function renderCustosApi() {
  const usd = Number(cfg().cotacaoDolar) || 5.5;
  const limite = Number(cfg().limiteIaUsd) || 0;
  const rows = [...(db.consumo || [])].sort((a, b) => b.data.localeCompare(a.data));
  const mes = rows.filter((r) => r.data.slice(0, 7) === TODAY.slice(0, 7));
  const ia = rows.filter((r) => r.api.startsWith("Anthropic"));
  const custoMes = sum(mes, (r) => r.custoUsd);
  const docsMes = mes.filter((r) => r.api.startsWith("Anthropic")).length;
  const porMes = {};
  for (const r of rows) { const k = r.data.slice(0, 7); (porMes[k] ||= { usd: 0, n: 0, tokens: 0 }); porMes[k].usd += r.custoUsd || 0; porMes[k].n++; porMes[k].tokens += (r.entrada || 0) + (r.saida || 0) + (r.cacheLeitura || 0); }
  const p = db.integracoes?.precoIa || {};
  const real = (v) => BRL(v * usd);
  return `<div class="kpis">
    ${kpi("Gasto com IA no mês", real(custoMes), `US$ ${custoMes.toFixed(2)} · dólar a R$ ${usd.toFixed(2).replace(".", ",")}`)}
    ${kpi("Documentos analisados no mês", docsMes, docsMes ? `${real(custoMes / docsMes)} por documento` : "")}
    ${kpi("Tokens no mês", sum(mes, (r) => (r.entrada || 0) + (r.saida || 0)).toLocaleString("pt-BR"), `${sum(mes, (r) => r.entrada || 0).toLocaleString("pt-BR")} de entrada · ${sum(mes, (r) => r.saida || 0).toLocaleString("pt-BR")} de saída`)}
    ${kpi("Projeção do mês", real(custoMes / Math.max(1, Number(TODAY.slice(8, 10))) * 30), "no ritmo atual")}
    ${kpi("Limite mensal de IA", limite ? `${Math.round((custoMes / limite) * 100)}%` : "sem limite", limite ? `US$ ${custoMes.toFixed(2)} de US$ ${limite.toFixed(2)} · ajuste em Configurações` : "defina um teto em Configurações", limite && custoMes >= limite * 0.8 ? "neg" : "")}
  </div>
  <div class="panel"><div class="panel__head"><h3 class="panel__title">APIs usadas e quanto custam</h3></div>
    <table class="table"><thead><tr><th>API</th><th>Para que serve</th><th>Como cobra</th><th class="num">Gasto no mês</th></tr></thead><tbody>
      <tr><td><b>Anthropic (Claude)</b><div class="crumbs">${escH(db.integracoes?.modeloIa || "")}</div></td><td>Lê e classifica notas, boletos e contratos que chegam por e-mail</td><td>Por token: US$ ${p.entrada ?? 4} por milhão de entrada, US$ ${p.saida ?? 20} por milhão de saída. Um PDF de nota fica em torno de 2 a 5 mil tokens.</td><td class="num">${real(sum(mes.filter((r) => r.api.startsWith("Anthropic")), (r) => r.custoUsd))}</td></tr>
      <tr><td><b>Google Gmail e Drive</b></td><td>Lê as caixas, envia lembretes e organiza os arquivos no Drive</td><td>Sem custo extra: incluído no Google Workspace (limites diários bem acima do uso da agência)</td><td class="num">${BRL(0)}</td></tr>
      <tr><td><b>Asaas</b></td><td>Boletos, Pix e NFS-e</td><td>Taxa por cobrança paga e por nota emitida, conforme o plano contratado no Asaas (cobrada lá, não aqui)</td><td class="num">—</td></tr>
      <tr><td><b>Vercel + Neon</b></td><td>Hospedagem e banco de dados</td><td>Plano da Vercel e do Neon (gratuitos até o limite de uso)</td><td class="num">—</td></tr>
    </tbody></table>
    <p class="empty">Cotação do dólar usada na conversão: ajuste em Configurações. Valores da IA são estimados pela tabela de preços; a fatura oficial fica no console da Anthropic.</p></div>
  <div class="panel"><div class="panel__head"><h3 class="panel__title">Por mês</h3></div>
    ${Object.keys(porMes).length ? `<table class="table"><thead><tr><th>Mês</th><th class="num">Chamadas</th><th class="num">Tokens</th><th class="num">US$</th><th class="num">R$</th></tr></thead><tbody>
      ${Object.entries(porMes).sort((a, b) => b[0].localeCompare(a[0])).map(([k, v]) => `<tr><td>${monthLabel(k)}</td><td class="num">${v.n}</td><td class="num">${v.tokens.toLocaleString("pt-BR")}</td><td class="num">${v.usd.toFixed(4)}</td><td class="num">${real(v.usd)}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">Nenhum consumo registrado ainda.</p>`}</div>` +
  table({ title: "Chamadas às APIs", rows,
    cols: [{ label: "Quando", get: (r) => new Date(r.data).toLocaleString("pt-BR") }, { label: "API", get: (r) => pill(r.api) }, { label: "Operação", get: txt("operacao") }, { label: "Referência", get: (r) => escH(r.ref || "—") },
      { label: "Tokens entrada", num: true, get: (r) => (r.entrada || 0).toLocaleString("pt-BR") }, { label: "Tokens saída", num: true, get: (r) => (r.saida || 0).toLocaleString("pt-BR") },
      { label: "Custo", num: true, get: (r) => real(r.custoUsd || 0) }] });
}

const REGIMES = { "Simples Nacional": 11.33, "Lucro Presumido": 16.33, "Lucro Real": 21.25 };
function renderConfig() {
  if (currentUser().perfil !== "admin") return `<div class="panel empty">Somente administradores podem alterar as configurações.</div>`;
  const c = cfg();
  const salvar = reg(() => {
    const regime = document.getElementById("cfgRegime").value;
    const aliquota = Number(document.getElementById("cfgAliquota").value) || 0;
    const encargos = Number(document.getElementById("cfgEncargos").value) || 0;
    const servicoMunicipal = document.getElementById("cfgServico").value.trim();
    const iss = Number(document.getElementById("cfgIss").value) || 0;
    const lembretesAtivos = document.getElementById("cfgLembretes").checked;
    const cotacaoDolar = Number(document.getElementById("cfgDolar").value) || 5.5;
    const limiteIaUsd = Number(document.getElementById("cfgLimiteIa").value) || 0;
    const alertasAtivos = document.getElementById("cfgAlertas").checked;
    db.config = [{ ...c, regime, aliquota, encargos, servicoMunicipal, iss, lembretesAtivos, cotacaoDolar, limiteIaUsd, alertasAtivos }];
    log("Configuração", `${regime}: impostos ${aliquota}% · encargos ${encargos}%`); toast("Configurações salvas"); render();
  });
  const sugerir = reg(() => { const r = document.getElementById("cfgRegime").value; document.getElementById("cfgAliquota").value = REGIMES[r]; });
  return `<div class="panel"><div class="panel__head"><h3 class="panel__title">Tributação e folha</h3></div>
    <div class="form-grid" style="max-width:640px">
      <label>Regime tributário<select id="cfgRegime">${Object.keys(REGIMES).map((r) => `<option ${r === c.regime ? "selected" : ""}>${r}</option>`).join("")}</select></label>
      <label>Alíquota total sobre faturamento (%)<input id="cfgAliquota" type="number" step="0.01" min="0" max="100" value="${c.aliquota}" /></label>
      <label>Encargos sobre salários (%)<input id="cfgEncargos" type="number" step="0.1" min="0" max="200" value="${c.encargos}" /></label>
      <label>Serviço municipal da NFS-e (como aparece na prefeitura)<input id="cfgServico" value="${escH(c.servicoMunicipal || "")}" placeholder="ex.: 17.06 - Propaganda e publicidade" /></label>
      <label>Alíquota de ISS (%)<input id="cfgIss" type="number" step="0.01" min="0" max="10" value="${c.iss ?? 5}" /></label>
      <label>Cotação do dólar (custos de APIs)<input id="cfgDolar" type="number" step="0.01" min="1" max="20" value="${c.cotacaoDolar ?? 5.5}" /></label>
      <label>Limite mensal de gasto com IA (US$, 0 = sem limite)<input id="cfgLimiteIa" type="number" step="1" min="0" value="${c.limiteIaUsd ?? 0}" /></label>
      <label class="check"><input id="cfgAlertas" type="checkbox" ${c.alertasAtivos ? "checked" : ""} /> Enviar também no WhatsApp (documentos novos, resumo diário de vencimentos e aprovações, limite de IA)</label>
      <label class="check"><input id="cfgLembretes" type="checkbox" ${c.lembretesAtivos ? "checked" : ""} /> Enviar lembretes de cobrança por e-mail aos clientes (3 dias antes e 1 dia após o vencimento)</label>
    </div>
    <p class="empty">Alíquotas sugeridas: Simples Nacional 11,33% (Anexo III, faixa inicial), Lucro Presumido 16,33% (PIS, COFINS, IRPJ, CSLL e ISS 5%), Lucro Real ~21,25%. Confirme com a contabilidade.</p>
    <div class="dialog__actions" style="justify-content:flex-start"><button class="btn-ghost" data-act="${sugerir}">Usar alíquota sugerida</button><button class="btn-primary" data-act="${salvar}">Salvar</button></div></div>
  <div class="panel"><div class="panel__head"><h3 class="panel__title">Integração Asaas (boleto, Pix e NFS-e)</h3>${asaasOn() ? pill(`conectado · ${db.integracoes.ambiente}`).replace("pill--", "pill--green ") : pill("não configurado")}</div>
    <ol class="steps">
      <li>Crie a conta em <a href="https://www.asaas.com" target="_blank" rel="noopener">asaas.com</a> (para testar sem cobrar ninguém, use o <a href="https://sandbox.asaas.com" target="_blank" rel="noopener">sandbox</a>) e conclua a configuração fiscal (dados da prefeitura) para emitir NFS-e.</li>
      <li>No Asaas, em <b>Integrações → Chave de API</b>, gere a chave.</li>
      <li>No projeto da Vercel, em <b>Settings → Environment Variables</b>, crie <code>ASAAS_API_KEY</code> com a chave e, para produção, <code>ASAAS_ENV=producao</code>. Crie também <code>ASAAS_WEBHOOK_TOKEN</code> com uma senha qualquer e faça um novo deploy.</li>
      <li>No Asaas, em <b>Integrações → Webhooks</b>, cadastre a URL <code>${escH(location.origin)}/api/asaas/webhook</code> com o mesmo token, para cobranças pagas e notas emitidas atualizarem sozinhas.</li>
    </ol></div>
  <div class="panel"><div class="panel__head"><h3 class="panel__title">Automação de e-mails (Gmail, Drive e IA)</h3>${(() => { const e = db.integracoes?.emails || {}; return e.google && e.ia ? pill("conectado").replace("pill--", "pill--green ") : pill("não configurado"); })()}</div>
    <p class="empty">Caixas monitoradas: ${escH((db.integracoes?.emails?.caixas || []).join(", "))} · lembretes saem de ${escH(db.integracoes?.emails?.remetente || "")}</p>
    <ol class="steps">
      <li>No <a href="https://console.cloud.google.com" target="_blank" rel="noopener">Google Cloud Console</a>, crie um projeto, ative as APIs <b>Gmail</b> e <b>Google Drive</b>, crie uma <b>conta de serviço</b> e gere uma chave JSON.</li>
      <li>No <a href="https://admin.google.com" target="_blank" rel="noopener">Admin do Google Workspace</a>, em <b>Segurança → Controles de API → Delegação em todo o domínio</b>, adicione o ID do cliente da conta de serviço com os escopos <code>https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/drive</code>.</li>
      <li>No Drive de financeiro@, crie a pasta <b>Mantra ERP</b> e copie o ID dela (o final do link).</li>
      <li>Na Vercel, crie as variáveis <code>GOOGLE_SERVICE_ACCOUNT</code> (conteúdo do JSON), <code>DRIVE_PASTA_RAIZ</code> (ID da pasta), <code>ANTHROPIC_API_KEY</code> e <code>CRON_SECRET</code> (uma senha qualquer), e faça um novo deploy.</li>
    </ol></div>
  ${renderArmazenamento()}
  <div class="panel"><div class="panel__head"><h3 class="panel__title">Notificações no app, navegador e WhatsApp</h3>${db.integracoes?.alertas?.whatsapp ? pill("WhatsApp conectado").replace("pill--", "pill--green ") : pill("WhatsApp não configurado")}</div>
    <ol class="steps">
      <li><b>No app:</b> o sino no menu lateral mostra documentos novos, o resumo diário, o limite de IA e falhas de backup. Funciona sem configurar nada.</li>
      <li><b>No navegador:</b> clique em "Ativar no navegador" (no sino ou abaixo) para receber o aviso do sistema mesmo com a aba do ERP em segundo plano.</li>
      <li><b>WhatsApp (opcional):</b> na <a href="https://business.facebook.com" target="_blank" rel="noopener">Meta Business</a>, ative a API do WhatsApp Cloud e crie na Vercel <code>WHATSAPP_TOKEN</code>, <code>WHATSAPP_PHONE_ID</code> e <code>WHATSAPP_PARA</code> (números com DDI, separados por vírgula). Para mensagens fora da janela de 24 h, aprove um modelo com uma variável e informe o nome em <code>WHATSAPP_TEMPLATE</code>. Depois marque "Enviar também no WhatsApp" acima.</li>
    </ol>
    <div class="dialog__actions" style="justify-content:flex-start"><button class="btn-ghost" data-act="${reg(ativarNavegador)}">Ativar no navegador</button><button class="btn-ghost" data-act="${reg(async () => { try { const r = await apiFetch("/api/alertas/teste", {}); await buscarNotificacoes(); toast(r.whatsapp ? "Teste enviado no app e no WhatsApp" : "Teste enviado no app"); } catch (e) { toast(e.message); } })}">Enviar notificação de teste</button></div></div>`;
}

const SUBTITULOS = {
  overview: "Gestão financeira, comercial e de pessoas da agência",
  financeiro: "Contas a pagar e receber, fluxo de caixa e conciliação com o extrato do banco.",
  faturamento: "Notas fiscais de serviço, impostos e envio à contabilidade.",
  compras: "Solicitações, cotações lado a lado, aprovações e fornecedores.",
  vendas: "Propostas, pedidos, follow-ups e cadastro de clientes.",
  contratos: "Vigências, reajustes, parcelas e cobranças recorrentes automáticas.",
  servicos: "Orçamento, horas, custos e rentabilidade por projeto e por cliente.",
  pessoas: "Colaboradores, remuneração, benefícios e documentos.",
  relatorios: "DRE, orçado × realizado, rentabilidade por cliente, receita e inadimplência.",
  aprovacoes: "Aprovações, usuários, permissões, configurações, custos de APIs e histórico de alterações.",
  emails: "Notas fiscais, boletos e contratos que chegam por e-mail, lidos e organizados automaticamente.",
  influenciadores: "Cadastro de influenciadores, contratos por campanha, NFs e pagamentos.",
};

/* ---------- Navegação ---------- */
const appEl = document.querySelector(".app");
const erpEl = document.getElementById("erp");
const state2 = { mod: "overview", tab: {} };

function renderRail() {
  document.getElementById("railModules").innerHTML = Object.entries(MODULES).filter(([k]) => can(k)).map(([k, m]) =>
    `<button class="rail__btn ${state2.mod === k ? "is-active" : ""}" data-mod="${k}" title="${m.label}" aria-label="${m.label}"><svg viewBox="0 0 24 24">${ICON[k]}</svg>${k === "emails" && emailsNovos() ? `<span class="rail__badge">${emailsNovos()}</span>` : ""}</button>`).join("");
  const u = currentUser();
  const ini = u.nome.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const naoLidas = notifNaoLidas();
  document.getElementById("userMenu").innerHTML = `<button class="rail__btn" id="btnNotif" title="Notificações" aria-label="Notificações"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>${naoLidas ? `<span class="rail__badge">${naoLidas > 9 ? "9+" : naoLidas}</span>` : ""}</button>
    <span class="user-avatar" title="${escH(u.nome)} · ${PERFIS[u.perfil].label}">${escH(ini)}</span>
    <button class="rail__btn" id="btnSenha" title="Trocar senha" aria-label="Trocar senha"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/></svg></button>
    <button class="rail__btn" id="btnSair" title="Sair" aria-label="Sair"><svg viewBox="0 0 24 24"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/></svg></button>`;
}

function render() { save(); renderView(); }
function renderView() {
  if (!db || !me) return;
  if (!can(state2.mod)) state2.mod = Object.keys(MODULES).find(can);
  renderRail();
  const mod = MODULES[state2.mod];
  const isKanban = state2.mod === "projetos";
  appEl.classList.toggle("erp-mode", !isKanban);
  erpEl.hidden = isKanban;
  if (isKanban) return renderKanban();
  actionRegistry = new Map();
  // Título em duas cores, como no Mantra Check-in: primeira palavra escura, resto em roxo.
  const [p1, ...resto] = (state2.mod === "overview" ? "Mantra Home" : mod.label).toUpperCase().split(" ");
  document.getElementById("erpTitle").innerHTML = `${escH(p1)} <span>${escH(resto.join(" "))}</span>`;
  document.getElementById("erpCrumbs").innerHTML = state2.mod === "overview"
    ? `${escH(SUBTITULOS.overview)}<span class="hello">Olá, ${escH(currentUser().nome.split(" ")[0])}! O que vamos fazer hoje?</span>`
    : escH(SUBTITULOS[state2.mod] || "");
  document.getElementById("erpHeadActions").innerHTML = state2.mod === "overview"
  && currentUser().perfil === "admin"
    ? `<button class="btn-ghost" data-act="${reg(async () => { if (confirm("Restaurar os dados de exemplo? Todos os registros (exceto usuários) serão apagados.")) { try { await syncChain; await apiFetch("/api/reset", {}); await loadData(); toast("Dados de exemplo restaurados"); renderView(); } catch (e) { toast(e.message); } } })}">Restaurar dados de exemplo</button>` : "";
  const tabsEl = document.getElementById("erpTabs");
  if (mod.tabs) {
    const names = Object.keys(mod.tabs);
    const cur = state2.tab[state2.mod] && names.includes(state2.tab[state2.mod]) ? state2.tab[state2.mod] : names[0];
    state2.tab[state2.mod] = cur;
    tabsEl.hidden = false;
    tabsEl.innerHTML = names.map((n) => `<button role="tab" data-tab="${escH(n)}" class="${n === cur ? "is-active" : ""}">${n}</button>`).join("");
    document.getElementById("erpBody").innerHTML = mod.tabs[cur]();
  } else {
    tabsEl.hidden = true;
    document.getElementById("erpBody").innerHTML = mod.render();
  }
}

document.getElementById("homeLink").addEventListener("click", (e) => {
  e.preventDefault();
  if (!me) return;
  state2.mod = can("overview") ? "overview" : Object.keys(MODULES).find(can);
  render();
});
document.getElementById("railModules").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mod]"); if (!b) return;
  state2.mod = b.dataset.mod; render();
});
document.getElementById("userMenu").addEventListener("click", async (e) => {
  if (e.target.closest("#btnSair")) {
    await syncChain.catch(() => {});
    await apiFetch("/api/logout", {}).catch(() => {});
    location.reload();
  }
  if (e.target.closest("#btnNotif")) return abrirNotificacoes();
  if (e.target.closest("#btnSenha")) { document.getElementById("senhaForm").reset(); document.getElementById("senhaDialog").showModal(); }
});
document.getElementById("senhaCancel").addEventListener("click", () => document.getElementById("senhaDialog").close());
document.getElementById("senhaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (fd.get("nova") !== fd.get("confirma")) return toast("As senhas novas não conferem");
  try { await apiFetch("/api/senha", { atual: fd.get("atual"), nova: fd.get("nova") }); document.getElementById("senhaDialog").close(); toast("Senha alterada"); }
  catch (err) { toast(err.message); }
});

/* ---------- Login ---------- */
const loginEl = document.getElementById("login");
function showLogin() { me = null; db = null; loginEl.hidden = false; appEl.hidden = true; document.getElementById("loginEmail").focus(); }
async function entrar() {
  await loadData(); loginEl.hidden = true; appEl.hidden = false; renderView();
  avisarNavegador(db.notificacoes || []);
  // Lê os e-mails novos em segundo plano (o servidor limita a uma leitura a cada 10 minutos).
  if (can("emails") && db.integracoes?.emails?.google && db.integracoes?.emails?.ia)
    apiAction("/api/emails/sincronizar", { auto: true }).then((r) => { if (r.novos) toast(`${r.novos} documento(s) novo(s) chegaram por e-mail`); }).catch(() => {});
}
document.getElementById("loginEye").addEventListener("click", (e) => {
  const inp = document.getElementById("loginSenha"), btn = e.currentTarget;
  const mostrar = inp.type === "password";
  inp.type = mostrar ? "text" : "password";
  btn.setAttribute("aria-pressed", mostrar); btn.setAttribute("aria-label", mostrar ? "Ocultar senha" : "Mostrar senha");
});
document.getElementById("loginForgot").addEventListener("click", () => {
  document.getElementById("loginErro").textContent = "Peça a um administrador para redefinir sua senha em Aprovações e acessos → Usuários.";
});
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fdCheck = new FormData(e.target);
  if (!fdCheck.get("email") || !fdCheck.get("senha")) { document.getElementById("loginErro").textContent = "Preencha e-mail e senha."; return; }
  const fd = new FormData(e.target);
  const err = document.getElementById("loginErro");
  err.textContent = "";
  try { me = (await apiFetch("/api/login", { email: fd.get("email"), senha: fd.get("senha") })).usuario; await entrar(); }
  catch (ex) { err.textContent = ex.message; }
});

document.getElementById("erpTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  state2.tab[state2.mod] = b.dataset.tab; render();
});
erpEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  actionRegistry.get(b.dataset.act)?.();
});
erpEl.addEventListener("change", (e) => {
  if (e.target.matches("[data-anorel]")) { anoRel = Number(e.target.value); return render(); }
  if (e.target.matches("[data-mesorc]") && e.target.value) { mesOrc = e.target.value; return render(); }
  if (e.target.dataset.emailf) { filtroEmail[e.target.dataset.emailf] = e.target.value; return render(); }
  if (e.target.id === "extratoFile" && e.target.files[0]) importarExtrato(e.target.files[0]).catch((err) => toast(err.message));
});
erpEl.addEventListener("input", (e) => {
  const inp = e.target.closest("[data-filter]"); if (!inp) return;
  tableFilters[inp.dataset.filter] = inp.value;
  const pos = inp.selectionStart; render();
  const again = erpEl.querySelector(`[data-filter="${CSS.escape(inp.dataset.filter)}"]`);
  if (again) { again.focus(); again.setSelectionRange(pos, pos); }
});

(async () => {
  try { me = (await apiFetch("/api/me")).usuario; await entrar(); }
  catch { showLogin(); }
})();
