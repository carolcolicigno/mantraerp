// Mantra ERP — servidor HTTP + API + SQLite (sem dependências externas).
// Uso: node server/server.js   (variáveis: PORT, DB_PATH, SEED_PASSWORD, COOKIE_SECURE)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const seed = require("./seed");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, "..");
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "mantra.db");
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
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS records (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (col, id));
  CREATE TABLE IF NOT EXISTS credenciais (user_id TEXT PRIMARY KEY, hash TEXT NOT NULL, salt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessoes (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expira INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS historico (id INTEGER PRIMARY KEY AUTOINCREMENT, quando TEXT NOT NULL, usuario TEXT NOT NULL, acao TEXT NOT NULL, detalhe TEXT NOT NULL);
`);
const q = {
  all: db.prepare("SELECT id, data FROM records WHERE col = ?"),
  get: db.prepare("SELECT data FROM records WHERE col = ? AND id = ?"),
  put: db.prepare("INSERT INTO records (col, id, data) VALUES (?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data"),
  del: db.prepare("DELETE FROM records WHERE col = ? AND id = ?"),
  delCol: db.prepare("DELETE FROM records WHERE col = ?"),
  cred: db.prepare("SELECT hash, salt FROM credenciais WHERE user_id = ?"),
  putCred: db.prepare("INSERT INTO credenciais (user_id, hash, salt) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, salt = excluded.salt"),
  delCred: db.prepare("DELETE FROM credenciais WHERE user_id = ?"),
  sess: db.prepare("SELECT user_id, expira FROM sessoes WHERE token = ?"),
  putSess: db.prepare("INSERT INTO sessoes (token, user_id, expira) VALUES (?, ?, ?)"),
  delSess: db.prepare("DELETE FROM sessoes WHERE token = ?"),
  delUserSess: db.prepare("DELETE FROM sessoes WHERE user_id = ?"),
  purgeSess: db.prepare("DELETE FROM sessoes WHERE expira < ?"),
  log: db.prepare("INSERT INTO historico (quando, usuario, acao, detalhe) VALUES (?, ?, ?, ?)"),
  hist: db.prepare("SELECT id, quando, usuario, acao, detalhe FROM historico ORDER BY id DESC LIMIT 500"),
};
const getRec = (col, id) => { const r = q.get.get(col, id); return r ? JSON.parse(r.data) : null; };
const listCol = (col) => q.all.all(col).map((r) => JSON.parse(r.data));
const findUserByEmail = (email) => listCol("usuarios").find((u) => u.email.toLowerCase() === String(email).toLowerCase());

function hashSenha(senha, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(senha), salt, 64).toString("hex") };
}
function confereSenha(userId, senha) {
  const c = q.cred.get(userId);
  if (!c) return false;
  const { hash } = hashSenha(senha, c.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(c.hash, "hex"));
}
function log(usuario, acao, detalhe) {
  const quando = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const info = q.log.run(quando, usuario, String(acao).slice(0, 80), String(detalhe).slice(0, 500));
  return { id: Number(info.lastInsertRowid), quando, usuario, acao, detalhe };
}
function tx(fn) {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}

function seedNegocio() {
  const s = seed();
  for (const col of COLLECTIONS) if (col !== "usuarios" && col !== "config") {
    q.delCol.run(col);
    for (const r of s[col] || []) q.put.run(col, r.id, JSON.stringify(r));
  }
  if (!getRec("config", "geral")) q.put.run("config", "geral", JSON.stringify(CONFIG_PADRAO));
}

// Primeira inicialização: cria dados de exemplo e usuários com senha inicial.
if (!listCol("usuarios").length) {
  const senha = process.env.SEED_PASSWORD || crypto.randomBytes(6).toString("base64url");
  tx(() => {
    seedNegocio();
    for (const u of seed().usuarios) {
      q.put.run("usuarios", u.id, JSON.stringify(u));
      const h = hashSenha(senha); q.putCred.run(u.id, h.hash, h.salt);
    }
  });
  console.log("\n=== Mantra ERP: banco criado ===");
  console.log("Usuários iniciais (troque as senhas após o primeiro acesso):");
  for (const u of seed().usuarios) console.log(`  ${u.email.padEnd(20)} perfil ${u.perfil}`);
  console.log(`Senha inicial de todos: ${senha}\n`);
}

/* ---------- Dados visíveis por usuário ---------- */
function dadosPara(u) {
  const out = {};
  for (const col of COLLECTIONS) out[col] = listCol(col);
  if (!hasModule(u, "pessoas")) out.colaboradores = out.colaboradores.map(({ id, nome, cargo, area }) => ({ id, nome, cargo, area }));
  if (!out.config.length) out.config = [CONFIG_PADRAO];
  out.historico = hasModule(u, "aprovacoes") ? q.hist.all() : [];
  return out;
}

/* ---------- Gravação em lote ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const labelOf = (r) => r?.descricao || r?.nome || r?.titulo || r?.item || r?.objeto || r?.numero || r?.id || "";

function aplicarLote(u, { changes = [], acao, detalhe }) {
  if (!Array.isArray(changes) || changes.length > 200) throw new HttpError(400, "Lote inválido");
  return tx(() => {
    for (const ch of changes) {
      const { op, col, id } = ch;
      if (!COLLECTIONS.includes(col) || typeof id !== "string" || !id || id.length > 64) throw new HttpError(400, "Registro inválido");
      if (!canWrite(u, col)) throw new HttpError(403, `Seu perfil não pode alterar ${col}`);
      const antes = getRec(col, id);

      if (op === "delete") {
        if (!antes) continue;
        if (col === "contas" && antes.tipo === "pagar" && !antes.aprovado && !canApprove(u)) throw new HttpError(403, "Somente aprovadores podem recusar despesas");
        if (col === "usuarios") {
          if (id === u.id) throw new HttpError(400, "Você não pode excluir o próprio usuário");
          q.delCred.run(id); q.delUserSess.run(id);
        }
        if (col === "config") throw new HttpError(400, "Configuração não pode ser excluída");
        q.del.run(col, id);
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
        const dono = findUserByEmail(data.email);
        if (dono && dono.id !== id) throw new HttpError(400, "E-mail já cadastrado");
        if (id === u.id && data.perfil !== "admin") throw new HttpError(400, "Você não pode remover seu próprio acesso de administrador");
        const senha = data.senha; delete data.senha;
        if (senha) {
          if (String(senha).length < 8) throw new HttpError(400, "A senha precisa ter ao menos 8 caracteres");
          const h = hashSenha(senha); q.putCred.run(id, h.hash, h.salt);
          if (antes) q.delUserSess.run(id);
        } else if (!antes) throw new HttpError(400, "Defina uma senha inicial para o novo usuário");
      }
      if (col === "config") {
        Object.assign(data, {
          regime: String(data.regime || CONFIG_PADRAO.regime),
          aliquota: Math.min(100, Math.max(0, Number(data.aliquota) || 0)),
          encargos: Math.min(200, Math.max(0, Number(data.encargos) || 0)),
        });
      }
      q.put.run(col, id, JSON.stringify(data));
    }
    const resumo = changes.map((c) => `${c.op === "delete" ? "−" : "+"}${c.col}`).join(" ");
    const entrada = acao
      ? log(u.nome, acao, detalhe || "")
      : changes.length
        ? log(u.nome, changes.length === 1 ? (changes[0].op === "delete" ? "Exclusão" : "Gravação") : "Alterações", changes.length === 1 ? `${changes[0].col}: ${labelOf(changes[0].data) || changes[0].id}` : resumo)
        : null;
    return entrada;
  });
}

/* ---------- HTTP ---------- */
const STATIC = { "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js", "/erp.js": "erp.js" };
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const tentativas = new Map(); // limite de tentativas de login por IP

function send(res, status, body, headers = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, { "Content-Type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
function readBody(req) {
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
function usuarioDaSessao(req) {
  const token = cookies(req).sid;
  if (!token) return null;
  const s = q.sess.get(token);
  if (!s || s.expira < Date.now()) { if (s) q.delSess.run(token); return null; }
  return getRec("usuarios", s.user_id);
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  // Proteção CSRF simples: escritas exigem cabeçalho próprio (navegadores não o enviam entre sites sem CORS).
  if (req.method !== "GET" && req.headers["x-mantra"] !== "1") throw new HttpError(403, "Requisição recusada");

  if (route === "POST /api/login") {
    const ip = req.socket.remoteAddress;
    const t = tentativas.get(ip) || { n: 0, desde: Date.now() };
    if (Date.now() - t.desde > 15 * 60e3) { t.n = 0; t.desde = Date.now(); }
    if (t.n >= 10) throw new HttpError(429, "Muitas tentativas. Aguarde 15 minutos.");
    const { email, senha } = await readBody(req);
    const u = findUserByEmail(email || "");
    if (!u || !confereSenha(u.id, senha || "")) { t.n++; tentativas.set(ip, t); throw new HttpError(401, "E-mail ou senha incorretos"); }
    tentativas.delete(ip);
    q.purgeSess.run(Date.now());
    const token = crypto.randomBytes(32).toString("hex");
    q.putSess.run(token, u.id, Date.now() + SESSION_DAYS * 864e5);
    log(u.nome, "Login", u.email);
    return send(res, 200, { usuario: u }, { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) });
  }

  const u = usuarioDaSessao(req);
  if (!u) throw new HttpError(401, "Faça login");

  if (route === "POST /api/logout") { q.delSess.run(cookies(req).sid); return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) }); }
  if (route === "GET /api/me") return send(res, 200, { usuario: u });
  if (route === "GET /api/data") return send(res, 200, dadosPara(u));
  if (route === "POST /api/sync") {
    const entrada = aplicarLote(u, await readBody(req));
    return send(res, 200, { ok: true, historico: entrada });
  }
  if (route === "POST /api/senha") {
    const { atual, nova } = await readBody(req);
    if (!confereSenha(u.id, atual || "")) throw new HttpError(400, "Senha atual incorreta");
    if (String(nova || "").length < 8) throw new HttpError(400, "A nova senha precisa ter ao menos 8 caracteres");
    const h = hashSenha(nova); q.putCred.run(u.id, h.hash, h.salt);
    log(u.nome, "Senha alterada", u.email);
    return send(res, 200, { ok: true });
  }
  if (route === "POST /api/reset") {
    if (!isAdmin(u)) throw new HttpError(403, "Somente administradores");
    tx(seedNegocio);
    log(u.nome, "Restauração", "Dados de exemplo restaurados");
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, "Rota não encontrada");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const file = STATIC[url.pathname];
    if (req.method !== "GET" || !file) return send(res, 404, "Não encontrado");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    fs.createReadStream(path.join(ROOT, file)).pipe(res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { erro: e instanceof HttpError ? e.message : "Erro interno" });
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`Mantra ERP em http://localhost:${PORT}`));
module.exports = server;
