// Mantra ERP — servidor HTTP + API. Banco: Postgres (DATABASE_URL) ou SQLite local.
// Uso local: node server/server.js   (variáveis: PORT, DB_PATH, DATABASE_URL, SEED_PASSWORD, COOKIE_SECURE)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const seed = require("./seed");
const { openStore } = require("./db");
const asaas = require("./asaas");
const automacao = require("./emails");
const ia = require("./ia");
const armazenamento = require("./armazenamento");
const alertas = require("./alertas");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, "..", "public");
const SESSION_DAYS = 7;

/* ---------- Regras de acesso ---------- */
const PERFIS = {
  admin: { modulos: "*", aprova: true },
  financeiro: { modulos: ["overview", "financeiro", "faturamento", "compras", "contratos", "relatorios", "aprovacoes", "emails", "influenciadores"], aprova: true },
  gestor: { modulos: ["overview", "projetos", "servicos", "vendas", "contratos", "compras", "pessoas", "relatorios", "aprovacoes", "influenciadores", "emails"], aprova: true },
  colaborador: { modulos: ["projetos", "servicos", "compras"], aprova: false },
};
// Coleção -> módulos que podem gravar nela.
const WRITE = {
  contas: ["financeiro", "aprovacoes", "contratos"],
  notas: ["faturamento", "financeiro"],
  compras: ["compras", "aprovacoes"],
  fornecedores: ["compras"],
  clientes: ["vendas"],
  propostas: ["vendas"],
  contratos: ["contratos", "vendas"],
  projetos: ["servicos", "vendas"],
  colaboradores: ["pessoas"],
  tarefas: ["projetos", "servicos"],
  concorrencias: ["vendas"],
  extrato: ["financeiro"],
  atividades: ["vendas"],
  influenciadores: ["influenciadores"],
  influContratos: ["influenciadores"],
  emails: ["emails"], // só status/vínculos; os itens são criados pela automação
  consumo: [], // gravado só pelo servidor
  midias: ["financeiro"],
  orcamentos: ["financeiro"],
  usuarios: [], // só admin
  config: [], // só admin
};
const COLLECTIONS = Object.keys(WRITE);
// Módulos do usuário: lista personalizada (se houver) ou a do perfil. Usuário bloqueado não acessa nada.
const MODULOS = ["overview", "projetos", "financeiro", "faturamento", "compras", "vendas", "contratos", "servicos", "pessoas", "relatorios", "aprovacoes", "influenciadores", "emails"];
const modulosDe = (u) => {
  if (!u || u.ativo === false || !PERFIS[u.perfil]) return [];
  if (u.perfil === "admin") return MODULOS;
  if (Array.isArray(u.modulos) && u.modulos.length) return u.modulos.filter((m) => MODULOS.includes(m));
  return PERFIS[u.perfil].modulos;
};
const hasModule = (u, mod) => modulosDe(u).includes(mod);
const isAdmin = (u) => u.perfil === "admin" && u.ativo !== false;
const canWrite = (u, col) => isAdmin(u) || (WRITE[col] || []).some((m) => hasModule(u, m));
const canApprove = (u) => u.ativo !== false && (u.perfil === "admin" || (typeof u.aprova === "boolean" ? u.aprova : !!PERFIS[u.perfil]?.aprova));

const CONFIG_PADRAO = { id: "geral", regime: "Simples Nacional", aliquota: 11.33, encargos: 68, servicoMunicipal: "", iss: 5 };

/* ---------- Banco ---------- */
const store = openStore();
const listCol = (col, s = store) => s.all(col);
const getRec = (col, id, s = store) => s.get(col, id);
const findUserByEmail = async (email, s = store) => (await s.all("usuarios")).find((u) => u.email.toLowerCase() === String(email).toLowerCase());

function hashSenha(senha, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(senha), salt, 64).toString("hex") };
}
async function confereSenha(userId, senha) {
  const c = await store.cred(userId);
  if (!c) return false;
  const { hash } = hashSenha(senha, c.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(c.hash, "hex"));
}
async function log(usuario, acao, detalhe, s = store) {
  const quando = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  acao = String(acao).slice(0, 80); detalhe = String(detalhe).slice(0, 500);
  const id = await s.log(quando, usuario, acao, detalhe);
  return { id, quando, usuario, acao, detalhe };
}

async function seedNegocio(s) {
  const d = seed();
  for (const col of COLLECTIONS) if (col !== "usuarios" && col !== "config") {
    // E-mails e consumo reais são preservados; só os exemplos são recriados.
    if (col === "emails" || col === "consumo") { for (const r of await s.all(col)) if (r.exemplo) await s.del(col, r.id); }
    else await s.delCol(col);
    for (const r of d[col] || []) await s.put(col, r.id, r);
  }
  if (!(await s.get("config", "geral"))) await s.put("config", "geral", CONFIG_PADRAO);
}

// Prepara o banco uma vez por processo: dados de exemplo e usuários iniciais.
let pronto = null;
function init() {
  return (pronto ||= (async () => {
    if (!store) return;
    const usuarios = await listCol("usuarios");
    if (usuarios.length) {
      // Bancos criados antes do Kanban: adiciona as tarefas de exemplo uma única vez.
      if (!(await listCol("tarefas")).length && (await getRec("projetos", "j1")) && !(await getRec("config", "kanban")))
        await store.tx(async (s) => { for (const r of seed().tarefas) await s.put("tarefas", r.id, r); await s.put("config", "kanban", { id: "kanban", migrado: true }); });
      return;
    }
    const senha = process.env.SEED_PASSWORD || crypto.randomBytes(6).toString("base64url");
    await store.tx(async (s) => {
      if ((await s.all("usuarios")).length) return; // outra instância já criou
      await seedNegocio(s);
      for (const u of seed().usuarios) {
        await s.put("usuarios", u.id, u);
        const h = hashSenha(senha); await s.putCred(u.id, h.hash, h.salt);
      }
    });
    console.log("\n=== Mantra ERP: banco criado ===");
    for (const u of seed().usuarios) console.log(`  ${u.email.padEnd(20)} perfil ${u.perfil}`);
    if (!process.env.SEED_PASSWORD) console.log(`Senha inicial de todos: ${senha}\n`);
  })().catch((e) => { pronto = null; throw e; }));
}

/* ---------- Dados visíveis por usuário ---------- */
async function dadosPara(u) {
  await gerarRecorrentes(u);
  const out = {};
  for (const col of COLLECTIONS) out[col] = await listCol(col);
  if (!hasModule(u, "pessoas")) out.colaboradores = out.colaboradores.map((c) => Object.fromEntries(CAMPOS_PUBLICOS_COLAB.filter((k) => k in c).map((k) => [k, c[k]])));
  out.docs = {};
  for (const col of Object.keys(ARQ_COLS)) if (hasModule(u, ARQ_COLS[col]) || canWrite(u, col)) out.docs[col] = await store.arqCount(col);
  out.config = [out.config.find((c) => c.id === "geral") || CONFIG_PADRAO];
  out.historico = hasModule(u, "aprovacoes") ? await store.hist() : [];
  // Caixa de e-mails: cada pessoa vê só as caixas da sua área; e-mails ignorados não vão para a tela.
  const veCaixa = (e) => hasModule(u, "emails") && hasModule(u, e.area === "influenciadores" ? "influenciadores" : "financeiro");
  out.emails = out.emails.filter((e) => e.status !== "ignorado" && veCaixa(e)).sort((a, b) => b.data.localeCompare(a.data)).slice(0, 500);
  out.consumo = isAdmin(u) || hasModule(u, "financeiro") ? out.consumo : [];
  const inbox = (await getRec("config", "inbox-status")) || {};
  out.integracoes = { asaas: asaas.configurado(), ambiente: asaas.ambiente(), emails: { ...automacao.status(), ultimaSync: inbox.ultimaSync || "", erros: inbox.erros || [] }, modeloIa: ia.MODELO, precoIa: ia.PRECO, alertas: alertas.canais(), drive: armazenamento.noDrive() };
  if (isAdmin(u)) out.integracoes.armazenamento = { resumo: await store.arqResumo(), backup: (await getRec("config", "backup-status")) || {} };
  return out;
}

/* ---------- Validações ---------- */
const digitos = (v) => String(v || "").replace(/\D/g, "");
function cpfValido(v) {
  const d = digitos(v);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(d[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(d[t])) return false;
  }
  return true;
}
function cnpjValido(v) {
  const d = digitos(v);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  for (const t of [12, 13]) {
    let soma = 0, peso = t - 7;
    for (let i = 0; i < t; i++) { soma += Number(d[i]) * peso--; if (peso < 2) peso = 9; }
    const dv = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    if (dv !== Number(d[t])) return false;
  }
  return true;
}
// Dados pessoais de colaboradores só saem para quem tem o módulo Pessoas.
const CAMPOS_PUBLICOS_COLAB = ["id", "nome", "cargo", "area", "fotoId", "_rev"];

/* ---------- Arquivos (logos, fotos e documentos) ---------- */
const ARQ_COLS = { concorrencias: "vendas", clientes: "vendas", fornecedores: "compras", contratos: "contratos", colaboradores: "pessoas", projetos: "servicos", influenciadores: "influenciadores", influContratos: "influenciadores", emails: "emails" };
const ARQ_TIPOS = {
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.ms-excel": "xls",
  "text/csv": "csv", "text/plain": "txt",
};
const ARQ_MAX = 3 * 1024 * 1024; // 3 MB por arquivo (limite de envio da Vercel é 4,5 MB)
const podeVerArquivo = (u, a) => canWrite(u, a.col) || hasModule(u, ARQ_COLS[a.col]) || (a.categoria === "logo") || (a.categoria === "foto");
async function enviarArquivo(u, body) {
  const { col, dono, categoria = "documento", nome, tipo, dados } = body || {};
  const tipoDoc = String(body?.tipoDoc || "Outros").slice(0, 40);
  if (!ARQ_COLS[col]) throw new HttpError(400, "Tipo de cadastro inválido");
  if (!canWrite(u, col)) throw new HttpError(403, "Seu perfil não pode anexar arquivos aqui");
  if (!["documento", "logo", "foto"].includes(categoria)) throw new HttpError(400, "Categoria inválida");
  if (!ARQ_TIPOS[tipo]) throw new HttpError(400, "Formato não aceito. Use PDF, imagem (PNG/JPG/WEBP), Word, Excel, CSV ou TXT.");
  if ((categoria !== "documento") && !tipo.startsWith("image/")) throw new HttpError(400, "Logo e foto precisam ser imagens");
  if (typeof dados !== "string" || !/^[A-Za-z0-9+/=]+$/.test(dados)) throw new HttpError(400, "Arquivo inválido");
  const tamanho = Math.floor((dados.length * 3) / 4) - (dados.endsWith("==") ? 2 : dados.endsWith("=") ? 1 : 0);
  if (tamanho > ARQ_MAX) throw new HttpError(413, "Arquivo maior que 3 MB");
  const rec = await getRec(col, String(dono || ""));
  if (!rec) throw new HttpError(404, "Salve o cadastro antes de anexar arquivos");
  const a = { id: crypto.randomBytes(12).toString("hex"), col, dono: rec.id, categoria, nome: String(nome || "arquivo").replace(/[\\/\r\n"]/g, "_").slice(0, 150), tipo, tamanho, criado_por: u.nome, criado_em: new Date().toISOString(), tipo_doc: tipoDoc };
  await armazenamento.guardar(store, a, Buffer.from(dados, "base64"), labelOf(rec));
  if (categoria === "documento") await log(u.nome, "Documento anexado", `${col}: ${labelOf(rec)} — ${a.nome}`);
  return a;
}

/* ---------- Cobranças recorrentes de contratos ---------- */
const addMonths = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };
function valorComReajuste(k, data) {
  const anos = Math.max(0, Math.floor((new Date(data) - new Date(k.inicio)) / (365.25 * 864e5)));
  return Math.round(Number(k.valorMensal) * Math.pow(1 + (Number(k.reajuste) || 0) / 100, anos) * 100) / 100;
}
// Gera, uma vez por mês e contrato, a parcela do mês atual e do próximo em Contas a receber.
// O id é determinístico (rec-<contrato>-<AAAA-MM>), então nunca há duplicidade.
let ultimaGeracao = 0;
async function gerarRecorrentes(u) {
  if (Date.now() - ultimaGeracao < 5 * 60e3) return;
  ultimaGeracao = Date.now();
  const hoje = new Date().toISOString().slice(0, 10);
  const contratos = await listCol("contratos");
  const contas = await listCol("contas");
  const criadas = [];
  await store.tx(async (s) => {
    for (const k of contratos) {
      if (!k.inicio || !k.fim || !(Number(k.valorMensal) > 0)) continue;
      for (const n of [0, 1]) {
        const dia = String(Math.min(28, Math.max(1, Number(k.diaVencimento) || 10))).padStart(2, "0");
        const venc = addMonths(hoje.slice(0, 8) + dia, n);
        if (venc < k.inicio || venc > k.fim) continue;
        const id = `rec-${k.id}-${venc.slice(0, 7)}`;
        if (await s.get("contas", id)) continue;
        const valor = valorComReajuste(k, venc);
        // Já existe lançamento do mesmo cliente, mês e valor (ex.: criado à mão)? Não duplica.
        if (contas.some((c) => c.tipo === "receber" && c.parceiro === k.cliente && c.vencimento.slice(0, 7) === venc.slice(0, 7) && (c.contrato === k.id || Math.abs(c.valor - valor) < 0.01 || Math.abs(c.valor - k.valorMensal) < 0.01))) continue;
        await s.put("contas", id, { id, tipo: "receber", descricao: `Parcela contrato — ${k.objeto}`, parceiro: k.cliente, categoria: "Fee", valor, vencimento: venc, status: "aberto", conciliado: false, aprovado: true, contrato: k.id });
        criadas.push(`${k.cliente} ${venc.slice(0, 7)}`);
      }
    }
    if (criadas.length) await log("Sistema", "Cobrança recorrente automática", criadas.join(", "), s);
  });
}

/* ---------- Asaas: cobranças e NFS-e ---------- */
async function integracao(u, acao, body) {
  if (!asaas.configurado()) throw new HttpError(400, "Integração com o Asaas não configurada (defina ASAAS_API_KEY no projeto da Vercel).");
  try {
    if (acao === "cobranca") {
      if (!canWrite(u, "contas")) throw new HttpError(403, "Seu perfil não pode gerar cobranças");
      const conta = await getRec("contas", String(body.contaId || ""));
      if (!conta || conta.tipo !== "receber") throw new HttpError(404, "Conta a receber não encontrada");
      if (conta.asaas?.id) throw new HttpError(400, "Essa conta já tem cobrança no Asaas");
      const cliente = (await listCol("clientes")).find((c) => c.nome === conta.parceiro);
      if (!cliente) throw new HttpError(400, `Cliente "${conta.parceiro}" não está cadastrado`);
      conta.asaas = await asaas.criarCobranca(conta, cliente);
      conta._rev = (Number(conta._rev) || 0) + 1;
      if (!cliente.asaasId) await store.put("clientes", cliente.id, { ...cliente, asaasId: conta.asaas.customer, _rev: (Number(cliente._rev) || 0) + 1 });
      await store.put("contas", conta.id, conta);
      const h = await log(u.nome, "Cobrança Asaas", `${conta.parceiro}: ${conta.descricao}`);
      return { registros: [{ col: "contas", rec: conta }], historico: h };
    }
    if (acao === "nfse") {
      if (!canWrite(u, "notas")) throw new HttpError(403, "Seu perfil não pode emitir notas");
      const conta = await getRec("contas", String(body.contaId || ""));
      if (!conta || conta.tipo !== "receber") throw new HttpError(404, "Conta a receber não encontrada");
      if (conta.nota) throw new HttpError(400, "Essa conta já tem nota");
      const cliente = (await listCol("clientes")).find((c) => c.nome === conta.parceiro);
      if (!cliente) throw new HttpError(400, `Cliente "${conta.parceiro}" não está cadastrado`);
      const cfg = (await getRec("config", "geral")) || CONFIG_PADRAO;
      const nota = { id: crypto.randomBytes(5).toString("hex"), numero: "", cliente: cliente.nome, valor: conta.valor, emissao: new Date().toISOString().slice(0, 10), status: "processando", contabilidade: false, conta: conta.id, descricao: conta.descricao };
      const r = await asaas.emitirNfse(nota, cliente, cfg);
      Object.assign(nota, { asaas: r, status: asaas.NOTA[r.status] || "processando", numero: r.numero || "" });
      conta.nota = nota.numero || "em emissão";
      conta._rev = (Number(conta._rev) || 0) + 1;
      await store.tx(async (s) => { await s.put("notas", nota.id, nota); await s.put("contas", conta.id, conta); });
      const h = await log(u.nome, "NFS-e solicitada", `${cliente.nome} — ${conta.descricao}`);
      return { registros: [{ col: "notas", rec: nota }, { col: "contas", rec: conta }], historico: h };
    }
    if (acao === "sincronizar") {
      const col = body.col === "notas" ? "notas" : "contas";
      if (!canWrite(u, col)) throw new HttpError(403, "Sem permissão");
      const rec = await getRec(col, String(body.id || ""));
      if (!rec?.asaas?.id) throw new HttpError(404, "Registro sem vínculo com o Asaas");
      const registros = col === "contas" ? await atualizarConta(rec, await asaas.consultarCobranca(rec.asaas.id)) : await atualizarNota(rec, await asaas.consultarNota(rec.asaas.id));
      return { registros };
    }
  } catch (e) {
    if (e instanceof asaas.AsaasError) throw new HttpError(502, e.message);
    throw e;
  }
  throw new HttpError(404, "Ação desconhecida");
}
async function atualizarConta(conta, p) {
  conta.asaas = { ...conta.asaas, ...p };
  if (asaas.PAGO.includes(p.status)) conta.status = "pago";
  conta._rev = (Number(conta._rev) || 0) + 1;
  await store.put("contas", conta.id, conta);
  return [{ col: "contas", rec: conta }];
}
async function atualizarNota(nota, n) {
  nota.asaas = { ...nota.asaas, ...n };
  nota.status = asaas.NOTA[n.status] || nota.status;
  if (n.numero) nota.numero = n.numero;
  nota._rev = (Number(nota._rev) || 0) + 1;
  await store.put("notas", nota.id, nota);
  const out = [{ col: "notas", rec: nota }];
  const conta = nota.conta && (await getRec("contas", nota.conta));
  if (conta && n.numero && conta.nota !== n.numero) { conta.nota = n.numero; conta._rev = (Number(conta._rev) || 0) + 1; await store.put("contas", conta.id, conta); out.push({ col: "contas", rec: conta }); }
  return out;
}
// Webhook do Asaas: confirma pagamentos e emissão de notas automaticamente.
async function webhookAsaas(req, res) {
  const token = process.env.ASAAS_WEBHOOK_TOKEN;
  const recebido = String(req.headers["asaas-access-token"] || "");
  if (!token || recebido.length !== token.length || !crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(token))) throw new HttpError(401, "Token inválido");
  const ev = await readBody(req);
  if (ev.payment?.externalReference) {
    const conta = await getRec("contas", ev.payment.externalReference);
    if (conta?.asaas?.id === ev.payment.id) {
      await atualizarConta(conta, { status: ev.payment.status });
      if (asaas.PAGO.includes(ev.payment.status)) await log("Asaas", "Pagamento recebido", `${conta.parceiro}: ${conta.descricao}`);
    }
  }
  if (ev.invoice?.externalReference) {
    const nota = await getRec("notas", ev.invoice.externalReference);
    if (nota?.asaas?.id === ev.invoice.id) {
      await atualizarNota(nota, { status: ev.invoice.status, numero: ev.invoice.number || "", pdf: ev.invoice.pdfUrl || "", motivo: ev.invoice.statusDescription || "" });
      await log("Asaas", "NFS-e atualizada", `${nota.cliente}: ${ev.invoice.status}`);
    }
  }
  return send(res, 200, { ok: true });
}

/* ---------- Automação de e-mails ---------- */
const alertasLigados = async () => !!((await getRec("config", "geral")) || {}).alertasAtivos;
const ctxAutomacao = {
  store, log: (acao, detalhe) => log("Automação", acao, detalhe),
  alerta: async (texto) => { if (await alertasLigados()) await alertas.enviar(texto); },
};
let sincronizando = null;
const rodarSync = () => (sincronizando ||= automacao.sincronizar(ctxAutomacao).finally(() => { sincronizando = null; }));
async function sincronizarEmails(u, body) {
  if (!hasModule(u, "emails")) throw new HttpError(403, "Sem acesso à caixa de e-mails");
  const st = automacao.status();
  if (!st.google || !st.ia) {
    if (body?.auto) return { registros: [] };
    throw new HttpError(400, !st.google ? "Conecte o Google Workspace (GOOGLE_SERVICE_ACCOUNT) para ler os e-mails." : "Configure a chave da IA (ANTHROPIC_API_KEY).");
  }
  // Ao abrir o ERP a leitura é automática, no máximo a cada 10 minutos.
  const ult = (await getRec("config", "inbox-status"))?.ultimaSync;
  if (body?.auto && ult && Date.now() - new Date(ult).getTime() < 10 * 60e3) return { registros: [] };
  try {
    const r = await rodarSync();
    const visiveis = r.novos.filter((e) => hasModule(u, e.area === "influenciadores" ? "influenciadores" : "financeiro"));
    return { registros: visiveis.map((rec) => ({ col: "emails", rec })), novos: visiveis.length, erros: r.erros, pendentes: r.pendentes };
  } catch (e) { throw new HttpError(502, e.message); }
}
// Vercel Cron: chama com "Authorization: Bearer CRON_SECRET".
async function cronEmails(req, res) {
  const segredo = process.env.CRON_SECRET, rec = String(req.headers.authorization || "");
  if (!segredo || rec.length !== segredo.length + 7 || !crypto.timingSafeEqual(Buffer.from(rec), Buffer.from(`Bearer ${segredo}`))) throw new HttpError(401, "Não autorizado");
  const st = automacao.status();
  const out = {};
  if (st.google && st.ia) { const r = await rodarSync().catch((e) => ({ erros: [e.message], novos: [] })); out.novos = r.novos.length; out.erros = r.erros; }
  out.lembretes = await automacao.enviarLembretes(ctxAutomacao).catch((e) => ({ erro: e.message }));
  out.backup = await armazenamento.backupNoDrive(store).catch((e) => ({ ok: false, motivo: e.message }));
  if (!out.backup.ok && out.backup.motivo !== "Drive não configurado") await ctxAutomacao.alerta(`⚠️ Backup diário do ERP falhou: ${out.backup.motivo}`);
  if (await alertasLigados()) { const r = await alertas.resumoDiario(store); if (r) out.resumo = await alertas.enviar(r); }
  await store.put("config", "backup-status", { id: "backup-status", ultimo: out.backup.ok ? new Date().toISOString() : ((await getRec("config", "backup-status"))?.ultimo || ""), ...out.backup });
  return send(res, 200, out);
}

/* ---------- Gravação em lote ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const labelOf = (r) => r?.descricao || r?.nome || r?.titulo || r?.item || r?.objeto || r?.numero || r?.id || "";

async function aplicarLote(u, { changes = [], acao, detalhe }) {
  if (!Array.isArray(changes) || changes.length > 200) throw new HttpError(400, "Lote inválido");
  const revs = [];
  const entrada = await store.tx(async (s) => {
    for (const ch of changes) {
      const { op, col, id } = ch;
      if (!COLLECTIONS.includes(col) || typeof id !== "string" || !id || id.length > 64) throw new HttpError(400, "Registro inválido");
      if (!canWrite(u, col) || col === "consumo") throw new HttpError(403, `Seu perfil não pode alterar ${col}`);
      const antes = await getRec(col, id, s);
      if (col === "config" && id !== "geral") throw new HttpError(403, "Configuração protegida");
      if (col === "emails" && (!antes || op === "delete")) throw new HttpError(400, "Itens da caixa de e-mails são criados pela automação");

      if (op === "delete") {
        if (!antes) continue;
        if (col === "contas" && antes.tipo === "pagar" && !antes.aprovado && !canApprove(u)) throw new HttpError(403, "Somente aprovadores podem recusar despesas");
        if (col === "usuarios") {
          if (id === u.id) throw new HttpError(400, "Você não pode excluir o próprio usuário");
          await s.delCred(id); await s.delUserSess(id);
        }
        if (col === "config") throw new HttpError(400, "Configuração não pode ser excluída");
        await s.del(col, id);
        if (ARQ_COLS[col]) await s.arqDelDono(col, id);
        continue;
      }
      if (op !== "put" || !ch.data || typeof ch.data !== "object") throw new HttpError(400, "Operação inválida");
      // Controle de concorrência: o registro precisa estar na mesma versão que o usuário editou.
      const revAntes = Number(antes?._rev) || 0;
      if (antes && (Number(ch.data._rev) || 0) !== revAntes) throw new HttpError(409, `"${labelOf(antes)}" foi alterado por outra pessoa. Os dados foram recarregados; refaça sua alteração.`);
      // Na caixa de e-mails só mudam status e vínculos; o restante vem da automação.
      const data = col === "emails"
        ? { ...antes, status: ["novo", "lançado", "arquivado"].includes(ch.data.status) ? ch.data.status : antes.status, contaId: String(ch.data.contaId || ""), vinculo: String(ch.data.vinculo || "").slice(0, 80), id, _rev: revAntes + 1 }
        : { ...ch.data, id, _rev: revAntes + 1 };
      revs.push({ col, id, rev: data._rev });
      if (JSON.stringify(data).length > 20000) throw new HttpError(413, "Registro grande demais");
      if (col === "clientes" || col === "fornecedores") {
        if (data.cnpj && digitos(data.cnpj).length === 14 && !cnpjValido(data.cnpj)) throw new HttpError(400, `CNPJ inválido: ${data.cnpj}`);
        if (data.cnpj && digitos(data.cnpj).length === 11 && !cpfValido(data.cnpj)) throw new HttpError(400, `CPF inválido: ${data.cnpj}`);
      }
      if (col === "colaboradores") {
        if (!hasModule(u, "pessoas")) throw new HttpError(403, "Sem acesso a dados de pessoas");
        if (data.cpf && !cpfValido(data.cpf)) throw new HttpError(400, `CPF inválido: ${data.cpf}`);
      }

      // Aprovação só por perfis aprovadores.
      if (col === "contas") {
        const aprovando = data.aprovado && !(antes ? antes.aprovado : false);
        if (!antes && !canApprove(u) && data.tipo === "pagar" && Number(data.valor) >= 5000) data.aprovado = false;
        else if (aprovando && antes && !canApprove(u)) throw new HttpError(403, "Somente aprovadores podem aprovar despesas");
      }
      if (col === "compras" && ["aprovado", "recusado"].includes(data.status) && antes?.status !== data.status && !canApprove(u))
        throw new HttpError(403, "Somente aprovadores podem aprovar compras");

      if (col === "usuarios") {
        if (!PERFIS[data.perfil]) throw new HttpError(400, "Perfil inválido");
        if (!/^[^@\s]+@[^@\s]+$/.test(data.email || "")) throw new HttpError(400, "E-mail inválido");
        const dono = await findUserByEmail(data.email, s);
        if (dono && dono.id !== id) throw new HttpError(400, "E-mail já cadastrado");
        if (id === u.id && (data.perfil !== "admin" || data.ativo === false)) throw new HttpError(400, "Você não pode remover nem bloquear seu próprio acesso de administrador");
        data.ativo = data.ativo !== false;
        data.modulos = Array.isArray(data.modulos) ? data.modulos.filter((m) => MODULOS.includes(m)) : [];
        if (!["sim", "nao", "perfil"].includes(data.aprovacao)) data.aprovacao = "perfil";
        data.aprova = data.aprovacao === "perfil" ? undefined : data.aprovacao === "sim";
        if (data.ativo === false) await s.delUserSess(id);
        const senha = data.senha; delete data.senha;
        if (senha) {
          if (String(senha).length < 8) throw new HttpError(400, "A senha precisa ter ao menos 8 caracteres");
          const h = hashSenha(senha); await s.putCred(id, h.hash, h.salt);
          if (antes) await s.delUserSess(id);
        } else if (!antes) throw new HttpError(400, "Defina uma senha inicial para o novo usuário");
      }
      if (col === "config") {
        Object.assign(data, {
          regime: String(data.regime || CONFIG_PADRAO.regime),
          aliquota: Math.min(100, Math.max(0, Number(data.aliquota) || 0)),
          encargos: Math.min(200, Math.max(0, Number(data.encargos) || 0)),
          servicoMunicipal: String(data.servicoMunicipal || "").slice(0, 200),
          iss: Math.min(10, Math.max(0, Number(data.iss) || 0)),
          lembretesAtivos: !!data.lembretesAtivos,
          cotacaoDolar: Math.min(20, Math.max(1, Number(data.cotacaoDolar) || 5.5)),
          limiteIaUsd: Math.min(10000, Math.max(0, Number(data.limiteIaUsd) || 0)),
          alertasAtivos: !!data.alertasAtivos,
        });
      }
      await s.put(col, id, data);
    }
    const resumo = changes.map((c) => `${c.op === "delete" ? "−" : "+"}${c.col}`).join(" ");
    const entrada = acao
      ? await log(u.nome, acao, detalhe || "", s)
      : changes.length
        ? await log(u.nome, changes.length === 1 ? (changes[0].op === "delete" ? "Exclusão" : "Gravação") : "Alterações", changes.length === 1 ? `${changes[0].col}: ${labelOf(changes[0].data) || changes[0].id}` : resumo, s)
        : null;
    return entrada;
  });
  return { entrada, revs };
}

/* ---------- HTTP ---------- */
const STATIC = { "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js", "/erp.js": "erp.js", "/logo.svg": "logo.svg", "/mantra-logo.png": "mantra-logo.png" }; // servidos de public/
const MIME = { ".png": "image/png", ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const tentativas = new Map(); // limite de tentativas de login por IP

function send(res, status, body, headers = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, { "Content-Type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
function readBody(req) {
  // Na Vercel o corpo já vem lido em req.body.
  if (process.env.VERCEL && "body" in req) {
    const b = req.body;
    if (b && typeof b === "object" && !Buffer.isBuffer(b)) return Promise.resolve(b);
    try { return Promise.resolve(b ? JSON.parse(String(b)) : {}); } catch { return Promise.reject(new HttpError(400, "JSON inválido")); }
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 4.5e6) { reject(new HttpError(413, "Corpo grande demais")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new HttpError(400, "JSON inválido")); } });
    req.on("error", reject);
  });
}
const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
function sessionCookie(token, maxAge) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`;
}
async function usuarioDaSessao(req) {
  const token = cookies(req).sid;
  if (!token) return null;
  const s = await store.sess(token);
  if (!s || s.expira < Date.now()) { if (s) await store.delSess(token); return null; }
  const u = await getRec("usuarios", s.user_id);
  return u && u.ativo !== false ? u : null;
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (!store) throw new HttpError(503, "Banco de dados não configurado. Conecte um banco Postgres ao projeto na Vercel.");
  await init();
  // Proteção CSRF simples: escritas exigem cabeçalho próprio (navegadores não o enviam entre sites sem CORS).
  if (route === "POST /api/asaas/webhook") return webhookAsaas(req, res);
  if (route === "GET /api/cron/emails") return cronEmails(req, res);
  if (req.method !== "GET" && req.headers["x-mantra"] !== "1") throw new HttpError(403, "Requisição recusada");

  if (route === "POST /api/login") {
    const ip = process.env.VERCEL ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : req.socket.remoteAddress;
    const t = tentativas.get(ip) || { n: 0, desde: Date.now() };
    if (Date.now() - t.desde > 15 * 60e3) { t.n = 0; t.desde = Date.now(); }
    if (t.n >= 10) throw new HttpError(429, "Muitas tentativas. Aguarde 15 minutos.");
    const { email, senha } = await readBody(req);
    const u = await findUserByEmail(email || "");
    if (!u || u.ativo === false || !(await confereSenha(u.id, senha || ""))) { t.n++; tentativas.set(ip, t); throw new HttpError(401, "E-mail ou senha incorretos"); }
    tentativas.delete(ip);
    await store.purgeSess(Date.now());
    const token = crypto.randomBytes(32).toString("hex");
    await store.putSess(token, u.id, Date.now() + SESSION_DAYS * 864e5);
    await log(u.nome, "Login", u.email);
    return send(res, 200, { usuario: { ...u, modulosEfetivos: modulosDe(u), podeAprovar: canApprove(u) } }, { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) });
  }

  const u = await usuarioDaSessao(req);
  if (!u) throw new HttpError(401, "Faça login");

  if (route === "POST /api/logout") { await store.delSess(cookies(req).sid); return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) }); }
  if (route === "GET /api/me") return send(res, 200, { usuario: { ...u, modulosEfetivos: modulosDe(u), podeAprovar: canApprove(u) } });
  if (route === "GET /api/data") return send(res, 200, await dadosPara(u));
  if (route === "POST /api/sync") {
    const { entrada, revs } = await aplicarLote(u, await readBody(req));
    return send(res, 200, { ok: true, historico: entrada, revs });
  }
  if (route === "POST /api/senha") {
    const { atual, nova } = await readBody(req);
    if (!(await confereSenha(u.id, atual || ""))) throw new HttpError(400, "Senha atual incorreta");
    if (String(nova || "").length < 8) throw new HttpError(400, "A nova senha precisa ter ao menos 8 caracteres");
    const h = hashSenha(nova); await store.putCred(u.id, h.hash, h.salt);
    await log(u.nome, "Senha alterada", u.email);
    return send(res, 200, { ok: true });
  }
  if (route === "POST /api/arquivos") return send(res, 200, await enviarArquivo(u, await readBody(req)));
  if (route === "GET /api/arquivos") {
    const col = url.searchParams.get("col"), dono = url.searchParams.get("dono") || "";
    if (!ARQ_COLS[col] || !(hasModule(u, ARQ_COLS[col]) || canWrite(u, col))) throw new HttpError(403, "Sem acesso");
    return send(res, 200, (await store.arqList(col, dono)).filter((a) => a.categoria === "documento"));
  }
  let m;
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/arquivos\/([a-f0-9]{24})$/))) {
    const a = await store.arqGet(m[1]);
    if (!a || !podeVerArquivo(u, a)) throw new HttpError(404, "Arquivo não encontrado");
    const imagem = a.tipo.startsWith("image/");
    res.writeHead(200, {
      "Content-Type": a.tipo, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Content-Disposition": `${imagem || a.tipo === "application/pdf" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.nome)}`,
    });
    let conteudo;
    try { conteudo = await armazenamento.ler(a); } catch (e) { throw new HttpError(502, `Não foi possível buscar o arquivo no Drive: ${e.message}`); }
    return res.end(conteudo);
  }
  if (req.method === "POST" && (m = url.pathname.match(/^\/api\/arquivos\/([a-f0-9]{24})\/excluir$/))) {
    const a = await store.arqMeta(m[1]);
    if (!a || !canWrite(u, a.col)) throw new HttpError(404, "Arquivo não encontrado");
    await armazenamento.apagar(store, a);
    if (a.categoria === "documento") await log(u.nome, "Documento removido", `${a.col}: ${a.nome}`);
    return send(res, 200, { ok: true });
  }
  if (route === "POST /api/integracoes/cobranca" || route === "POST /api/integracoes/nfse" || route === "POST /api/integracoes/sincronizar")
    return send(res, 200, await integracao(u, route.split("/").pop(), await readBody(req)));
  if (route === "POST /api/emails/sincronizar") return send(res, 200, await sincronizarEmails(u, await readBody(req)));
  if (route === "GET /api/backup") {
    if (!isAdmin(u)) throw new HttpError(403, "Somente administradores");
    await log(u.nome, "Backup baixado", "Cópia completa dos dados");
    return send(res, 200, await armazenamento.gerarBackup(store), { "Content-Disposition": `attachment; filename="mantra-erp-${new Date().toISOString().slice(0, 10)}.json"` });
  }
  if (route === "POST /api/backup/drive") {
    if (!isAdmin(u)) throw new HttpError(403, "Somente administradores");
    const r = await armazenamento.backupNoDrive(store).catch((e) => { throw new HttpError(502, e.message); });
    if (!r.ok) throw new HttpError(400, "Configure o Google Drive para salvar backups lá");
    await store.put("config", "backup-status", { id: "backup-status", ultimo: new Date().toISOString(), ...r });
    return send(res, 200, r);
  }
  if (route === "POST /api/arquivos/migrar") {
    if (!isAdmin(u)) throw new HttpError(403, "Somente administradores");
    const nomeDono = async (col, id) => labelOf(await getRec(col, id));
    try { const r = await armazenamento.migrar(store, nomeDono); if (r.movidos) await log(u.nome, "Arquivos movidos para o Drive", `${r.movidos} documentos`); return send(res, 200, { ...r, resumo: await store.arqResumo() }); }
    catch (e) { throw new HttpError(e instanceof HttpError ? e.status : 502, e.message); }
  }
  if (route === "POST /api/alertas/teste") {
    if (!isAdmin(u)) throw new HttpError(403, "Somente administradores");
    const c = alertas.canais();
    if (!c.slack && !c.whatsapp) throw new HttpError(400, "Nenhum canal configurado (SLACK_WEBHOOK_URL ou WHATSAPP_*)");
    const r = await alertas.enviar((await alertas.resumoDiario(store)) || "✅ Teste de alerta do Mantra ERP: tudo em dia por aqui.");
    if (!r.enviado) throw new HttpError(502, r.erros.join(" · "));
    return send(res, 200, { ok: true, erros: r.erros });
  }
  if (route === "POST /api/reset") {
    if (!isAdmin(u)) throw new HttpError(403, "Somente administradores");
    await store.tx(seedNegocio);
    await log(u.nome, "Restauração", "Dados de exemplo restaurados");
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, "Rota não encontrada");
}

async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const file = STATIC[url.pathname];
    if (req.method !== "GET" || !file) return send(res, 404, "Não encontrado");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { erro: e instanceof HttpError ? e.message : "Erro interno" });
  }
}
const server = http.createServer(handler);

if (require.main === module) server.listen(PORT, () => console.log(`Mantra ERP em http://localhost:${PORT}`));
module.exports = { server, handler };
