// Mantra ERP — servidor HTTP + API. Banco: Postgres (DATABASE_URL) ou SQLite local.
// Uso local: node server/server.js   (variáveis: PORT, DB_PATH, DATABASE_URL, SEED_PASSWORD, COOKIE_SECURE)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const seed = require("./seed");
const { openStore } = require("./db");

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
  usuarios: [], // só admin
  config: [], // só admin
};
const COLLECTIONS = Object.keys(WRITE);
const hasModule = (u, mod) => { const p = PERFIS[u.perfil]; return !!p && (p.modulos === "*" || p.modulos.includes(mod)); };
const isAdmin = (u) => u.perfil === "admin";
const canWrite = (u, col) => isAdmin(u) || (WRITE[col] || []).some((m) => hasModule(u, m));
const canApprove = (u) => !!PERFIS[u.perfil]?.aprova;

const CONFIG_PADRAO = { id: "geral", regime: "Simples Nacional", aliquota: 11.33, encargos: 68 };

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
  const out = {};
  for (const col of COLLECTIONS) out[col] = await listCol(col);
  if (!hasModule(u, "pessoas")) out.colaboradores = out.colaboradores.map(({ id, nome, cargo, area }) => ({ id, nome, cargo, area }));
  out.config = [out.config.find((c) => c.id === "geral") || CONFIG_PADRAO];
  out.historico = hasModule(u, "aprovacoes") ? await store.hist() : [];
  return out;
}

/* ---------- Gravação em lote ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const labelOf = (r) => r?.descricao || r?.nome || r?.titulo || r?.item || r?.objeto || r?.numero || r?.id || "";

async function aplicarLote(u, { changes = [], acao, detalhe }) {
  if (!Array.isArray(changes) || changes.length > 200) throw new HttpError(400, "Lote inválido");
  return store.tx(async (s) => {
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
        continue;
      }
      if (op !== "put" || !ch.data || typeof ch.data !== "object") throw new HttpError(400, "Operação inválida");
      const data = { ...ch.data, id };
      if (JSON.stringify(data).length > 20000) throw new HttpError(413, "Registro grande demais");

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
}

/* ---------- HTTP ---------- */
const STATIC = { "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js", "/erp.js": "erp.js" }; // servidos de public/
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
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
    req.on("data", (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, "Corpo grande demais")); req.destroy(); } else chunks.push(c); });
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
    const entrada = await aplicarLote(u, await readBody(req));
    return send(res, 200, { ok: true, historico: entrada });
  }
  if (route === "POST /api/senha") {
    const { atual, nova } = await readBody(req);
    if (!(await confereSenha(u.id, atual || ""))) throw new HttpError(400, "Senha atual incorreta");
    if (String(nova || "").length < 8) throw new HttpError(400, "A nova senha precisa ter ao menos 8 caracteres");
    const h = hashSenha(nova); await store.putCred(u.id, h.hash, h.salt);
    await log(u.nome, "Senha alterada", u.email);
    return send(res, 200, { ok: true });
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
