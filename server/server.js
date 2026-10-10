// Mantra ERP — servidor HTTP + API. Banco: Postgres (DATABASE_URL) ou SQLite local.
// Uso local: node server/server.js   (variáveis: PORT, DB_PATH, DATABASE_URL, SEED_PASSWORD, COOKIE_SECURE)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const seed = require("./seed");
const { openStore } = require("./db");
const asaas = require("./asaas");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, "..", "public");
const SESSION_DAYS = 7;

/* ---------- Regras de acesso ---------- */
const PERFIS = {
  admin: { modulos: "*", aprova: true },
  financeiro: { modulos: ["overview", "financeiro", "faturamento", "compras", "contratos", "relatorios", "aprovacoes"], aprova: true },
  gestor: { modulos: ["overview", "projetos", "servicos", "vendas", "contratos", "compras", "pessoas", "relatorios", "aprovacoes"], aprova: true },
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
  extrato: ["financeiro"],
  atividades: ["vendas"],
  usuarios: [], // só admin
  config: [], // só admin
};
const COLLECTIONS = Object.keys(WRITE);
const hasModule = (u, mod) => { const p = PERFIS[u.perfil]; return !!p && (p.modulos === "*" || p.modulos.includes(mod)); };
const isAdmin = (u) => u.perfil === "admin";
const canWrite = (u, col) => isAdmin(u) || (WRITE[col] || []).some((m) => hasModule(u, m));
const canApprove = (u) => !!PERFIS[u.perfil]?.aprova;

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
    await s.delCol(col);
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
  out.integracoes = { asaas: asaas.configurado(), ambiente: asaas.ambiente() };
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
const ARQ_COLS = { clientes: "vendas", fornecedores: "compras", contratos: "contratos", colaboradores: "pessoas", projetos: "servicos" };
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
  const a = { id: crypto.randomBytes(12).toString("hex"), col, dono: rec.id, categoria, nome: String(nome || "arquivo").replace(/[\\/\r\n"]/g, "_").slice(0, 150), tipo, tamanho, dados, criado_por: u.nome, criado_em: new Date().toISOString() };
  await store.arqPut(a);
  if (categoria === "documento") await log(u.nome, "Documento anexado", `${col}: ${labelOf(rec)} — ${a.nome}`);
  const { dados: _, ...meta } = a;
  return meta;
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
      if (!canWrite(u, col)) throw new HttpError(403, `Seu perfil não pode alterar ${col}`);
      const antes = await getRec(col, id, s);

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
      const data = { ...ch.data, id, _rev: revAntes + 1 };
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
        if (id === u.id && data.perfil !== "admin") throw new HttpError(400, "Você não pode remover seu próprio acesso de administrador");
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
const STATIC = { "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js", "/erp.js": "erp.js", "/logo.svg": "logo.svg" }; // servidos de public/
const MIME = { ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
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
  return getRec("usuarios", s.user_id);
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (!store) throw new HttpError(503, "Banco de dados não configurado. Conecte um banco Postgres ao projeto na Vercel.");
  await init();
  // Proteção CSRF simples: escritas exigem cabeçalho próprio (navegadores não o enviam entre sites sem CORS).
  if (route === "POST /api/asaas/webhook") return webhookAsaas(req, res);
  if (req.method !== "GET" && req.headers["x-mantra"] !== "1") throw new HttpError(403, "Requisição recusada");

  if (route === "POST /api/login") {
    const ip = process.env.VERCEL ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : req.socket.remoteAddress;
    const t = tentativas.get(ip) || { n: 0, desde: Date.now() };
    if (Date.now() - t.desde > 15 * 60e3) { t.n = 0; t.desde = Date.now(); }
    if (t.n >= 10) throw new HttpError(429, "Muitas tentativas. Aguarde 15 minutos.");
    const { email, senha } = await readBody(req);
    const u = await findUserByEmail(email || "");
    if (!u || !(await confereSenha(u.id, senha || ""))) { t.n++; tentativas.set(ip, t); throw new HttpError(401, "E-mail ou senha incorretos"); }
    tentativas.delete(ip);
    await store.purgeSess(Date.now());
    const token = crypto.randomBytes(32).toString("hex");
    await store.putSess(token, u.id, Date.now() + SESSION_DAYS * 864e5);
    await log(u.nome, "Login", u.email);
    return send(res, 200, { usuario: u }, { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) });
  }

  const u = await usuarioDaSessao(req);
  if (!u) throw new HttpError(401, "Faça login");

  if (route === "POST /api/logout") { await store.delSess(cookies(req).sid); return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) }); }
  if (route === "GET /api/me") return send(res, 200, { usuario: u });
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
    return res.end(Buffer.from(a.dados, "base64"));
  }
  if (req.method === "POST" && (m = url.pathname.match(/^\/api\/arquivos\/([a-f0-9]{24})\/excluir$/))) {
    const a = await store.arqMeta(m[1]);
    if (!a || !canWrite(u, a.col)) throw new HttpError(404, "Arquivo não encontrado");
    await store.arqDel(a.id);
    if (a.categoria === "documento") await log(u.nome, "Documento removido", `${a.col}: ${a.nome}`);
    return send(res, 200, { ok: true });
  }
  if (route === "POST /api/integracoes/cobranca" || route === "POST /api/integracoes/nfse" || route === "POST /api/integracoes/sincronizar")
    return send(res, 200, await integracao(u, route.split("/").pop(), await readBody(req)));
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
