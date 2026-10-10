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
const SYNC_COLS = ["contas", "notas", "compras", "fornecedores", "clientes", "propostas", "contratos", "projetos", "colaboradores", "usuarios", "config", "tarefas", "extrato", "atividades"];
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
  financeiro: { label: "Financeiro", modulos: ["overview", "financeiro", "faturamento", "compras", "contratos", "relatorios", "aprovacoes"], aprova: true },
  gestor: { label: "Gestor", modulos: ["overview", "projetos", "servicos", "vendas", "contratos", "compras", "pessoas", "relatorios", "aprovacoes"], aprova: true },
  colaborador: { label: "Colaborador", modulos: ["projetos", "servicos", "compras"], aprova: false },
};
const can = (mod) => { const p = PERFIS[currentUser().perfil]; return p.modulos === "*" || p.modulos.includes(mod); };
const canApprove = () => PERFIS[currentUser().perfil].aprova;

/* ---------- Esquemas de cadastro ---------- */
const opts = (col, key = "nome") => () => db[col].map((x) => x[key]);
const SCHEMAS = {
  contas: { singular: "Lançamento", fields: [
    { k: "tipo", label: "Tipo", type: "select", options: ["receber", "pagar"] },
    { k: "descricao", label: "Descrição" },
    { k: "parceiro", label: "Cliente / Fornecedor" },
    { k: "categoria", label: "Categoria", type: "select", options: ["Fee", "Projeto", "Produção", "Mídia", "Software", "Estrutura", "Pessoal", "Impostos", "Outros"] },
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
  usuarios: { singular: "Usuário", fields: [
    { k: "nome", label: "Nome" }, { k: "email", label: "E-mail" },
    { k: "perfil", label: "Perfil", type: "select", options: Object.keys(PERFIS) },
    { k: "senha", label: "Senha (mín. 8; em branco mantém a atual)", type: "password" },
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
      input = `<input type="checkbox" name="${f.k}" ${v ? "checked" : ""} />`;
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
async function enviarArquivo(col, dono, file, categoria = "documento") {
  if (file.size > 3 * 1024 * 1024) throw new Error(`"${file.name}" é maior que 3 MB`);
  return apiFetch("/api/arquivos", { col, dono, categoria, nome: file.name, tipo: file.type || "application/octet-stream", dados: await paraBase64(file) });
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
  atrasado: "red", conciliado: "green", processando: "yellow", erro: "red", hoje: "blue", agendado: "", "concluído": "green", "sem correspondência": "yellow", ignorado: "", pendente: "yellow", "previsão": "blue", recusado: "red", perdida: "red", cancelada: "red", encerrado: "", "aguardando aprovação": "purple",
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

/* ----- Documentos anexados ----- */
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
    dlg.innerHTML = `<h2>Documentos — ${escH(labelOf(rec))}</h2>
      ${lista.length ? `<table class="table"><thead><tr><th>Arquivo</th><th class="num">Tamanho</th><th>Enviado por</th><th>Data</th><th></th></tr></thead><tbody>
        ${lista.map((a) => `<tr><td><a href="${fileUrl(a.id)}" target="_blank" rel="noopener">${escH(a.nome)}</a></td><td class="num">${fmtBytes(a.tamanho)}</td>
          <td>${escH(a.criado_por)}</td><td>${new Date(a.criado_em).toLocaleDateString("pt-BR")}</td>
          <td><div class="row-actions"><a class="btn-mini" href="${fileUrl(a.id)}" download="${escH(a.nome)}">Baixar</a>${podeEditar ? `<button class="no" data-del="${a.id}">Excluir</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table>` : `<p class="empty">Nenhum documento anexado.</p>`}
      ${podeEditar ? `<label class="dropzone" id="docDrop"><input type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt" />
        <b>Clique para anexar</b> ou arraste arquivos aqui<br /><span class="crumbs">PDF, imagens, Word, Excel, CSV ou TXT · até 3 MB cada</span></label>` : ""}
      <div class="dialog__actions"><button class="btn-ghost" data-close>Fechar</button></div>`;
  };
  const enviar = async (files) => {
    for (const f of files) {
      try { toast(`Enviando ${f.name}…`); await enviarArquivo(col, rec.id, f); } catch (e) { toast(e.message); }
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
  dlg.ondragover = (e) => { e.preventDefault(); document.getElementById("docDrop")?.classList.add("is-over"); };
  dlg.ondragleave = () => document.getElementById("docDrop")?.classList.remove("is-over");
  dlg.ondrop = (e) => { e.preventDefault(); if (podeEditar && e.dataTransfer.files.length) enviar([...e.dataTransfer.files]); };
  await draw(); dlg.showModal();
}
const MODULO_DOC = { clientes: "vendas", fornecedores: "compras", contratos: "contratos", colaboradores: "pessoas", projetos: "servicos" };
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
  aprovacoes: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
};

const MODULES = {
  overview: { label: "Visão geral", render: renderOverview },
  projetos: { label: "Projetos (Kanban)" },
  financeiro: { label: "Financeiro", tabs: {
    "Contas a receber": () => contasTable("receber"),
    "Contas a pagar": () => contasTable("pagar"),
    "Fluxo de caixa": renderFluxo,
    "Conciliação bancária": renderConciliacao,
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
    Clientes: () => table({ title: "Clientes", rows: db.clientes, addCol: "clientes",
      cols: [{ label: "Cliente", get: (r) => thumb(r.logoId, r.nome) }, { label: "CNPJ", get: txt("cnpj") }, { label: "Contato", get: (r) => escH([r.contatoNome, r.contato, r.telefone].filter(Boolean).join(" · ") || "—") }, { label: "Cidade", get: (r) => escH([r.cidade, r.uf].filter(Boolean).join("/") || "—") }, { label: "Segmento", get: (r) => (r.segmento ? pill(r.segmento) : "—") },
        { label: "Receita (12m)", num: true, get: (r) => BRL(sum(receber().filter((c) => c.parceiro === r.nome && c.status === "pago"), (c) => c.valor)) },
        { label: "Em aberto", num: true, get: (r) => BRL(sum(receber().filter((c) => c.parceiro === r.nome && c.status !== "pago"), (c) => c.valor)) }],
      actions: (r) => [docsAction("clientes")(r), ...editDel("clientes")(r)] }),
  } },
  contratos: { label: "Contratos", render: renderContratos },
  servicos: { label: "Projetos e serviços", render: renderServicos },
  pessoas: { label: "Pessoas", render: renderPessoas },
  relatorios: { label: "Relatórios gerenciais", render: renderRelatorios },
  aprovacoes: { label: "Aprovações e acessos", tabs: {
    "Aprovações pendentes": renderAprovacoes,
    "Usuários e permissões": renderUsuarios,
    "Configurações": renderConfig,
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

function renderUsuarios() {
  const isAdmin = currentUser().perfil === "admin";
  const mods = Object.keys(MODULES);
  return table({ title: "Usuários", rows: db.usuarios, addCol: isAdmin ? "usuarios" : null, addDefaults: { perfil: "colaborador" },
    cols: [{ label: "Nome", get: txt("nome") }, { label: "E-mail", get: txt("email") }, { label: "Perfil", get: (r) => pill(PERFIS[r.perfil]?.label || r.perfil) }],
    actions: isAdmin ? editDel("usuarios") : null }) +
  `<div class="panel"><div class="panel__head"><h3 class="panel__title">Matriz de permissões por perfil</h3></div>
    <table class="table matrix"><thead><tr><th>Módulo</th>${Object.values(PERFIS).map((p) => `<th>${p.label}</th>`).join("")}</tr></thead>
    <tbody>${mods.map((mod) => `<tr><td>${MODULES[mod].label}</td>${Object.values(PERFIS).map((p) => `<td>${p.modulos === "*" || p.modulos.includes(mod) ? "✓" : "—"}</td>`).join("")}</tr>`).join("")}
    <tr><td>Aprovar despesas e compras</td>${Object.values(PERFIS).map((p) => `<td>${p.aprova ? "✓" : "—"}</td>`).join("")}</tr></tbody></table></div>`;
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
    db.config = [{ ...c, regime, aliquota, encargos, servicoMunicipal, iss }];
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
    </div>
    <p class="empty">Alíquotas sugeridas: Simples Nacional 11,33% (Anexo III, faixa inicial), Lucro Presumido 16,33% (PIS, COFINS, IRPJ, CSLL e ISS 5%), Lucro Real ~21,25%. Confirme com a contabilidade.</p>
    <div class="dialog__actions" style="justify-content:flex-start"><button class="btn-ghost" data-act="${sugerir}">Usar alíquota sugerida</button><button class="btn-primary" data-act="${salvar}">Salvar</button></div></div>
  <div class="panel"><div class="panel__head"><h3 class="panel__title">Integração Asaas (boleto, Pix e NFS-e)</h3>${asaasOn() ? pill(`conectado · ${db.integracoes.ambiente}`).replace("pill--", "pill--green ") : pill("não configurado")}</div>
    <ol class="steps">
      <li>Crie a conta em <a href="https://www.asaas.com" target="_blank" rel="noopener">asaas.com</a> (para testar sem cobrar ninguém, use o <a href="https://sandbox.asaas.com" target="_blank" rel="noopener">sandbox</a>) e conclua a configuração fiscal (dados da prefeitura) para emitir NFS-e.</li>
      <li>No Asaas, em <b>Integrações → Chave de API</b>, gere a chave.</li>
      <li>No projeto da Vercel, em <b>Settings → Environment Variables</b>, crie <code>ASAAS_API_KEY</code> com a chave e, para produção, <code>ASAAS_ENV=producao</code>. Crie também <code>ASAAS_WEBHOOK_TOKEN</code> com uma senha qualquer e faça um novo deploy.</li>
      <li>No Asaas, em <b>Integrações → Webhooks</b>, cadastre a URL <code>${escH(location.origin)}/api/asaas/webhook</code> com o mesmo token, para cobranças pagas e notas emitidas atualizarem sozinhas.</li>
    </ol></div>`;
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
  relatorios: "Receita, despesas, inadimplência e resultado por área e por cliente.",
  aprovacoes: "Aprovações, usuários, permissões, configurações e histórico de alterações.",
};

/* ---------- Navegação ---------- */
const appEl = document.querySelector(".app");
const erpEl = document.getElementById("erp");
const state2 = { mod: "overview", tab: {} };

function renderRail() {
  document.getElementById("railModules").innerHTML = Object.entries(MODULES).filter(([k]) => can(k)).map(([k, m]) =>
    `<button class="rail__btn ${state2.mod === k ? "is-active" : ""}" data-mod="${k}" title="${m.label}" aria-label="${m.label}"><svg viewBox="0 0 24 24">${ICON[k]}</svg></button>`).join("");
  const u = currentUser();
  const ini = u.nome.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  document.getElementById("userMenu").innerHTML = `<span class="user-avatar" title="${escH(u.nome)} · ${PERFIS[u.perfil].label}">${escH(ini)}</span>
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
async function entrar() { await loadData(); loginEl.hidden = true; appEl.hidden = false; renderView(); }
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
