// Camada de armazenamento: Postgres quando DATABASE_URL existe (Vercel), SQLite local caso contrário.
// Todas as funções são assíncronas e as consultas usam "?" como marcador (convertido para $n no Postgres).
const path = require("node:path");
const fs = require("node:fs");

const SCHEMA = {
  sqlite: `
    CREATE TABLE IF NOT EXISTS records (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (col, id));
    CREATE TABLE IF NOT EXISTS credenciais (user_id TEXT PRIMARY KEY, hash TEXT NOT NULL, salt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessoes (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expira BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS historico (id INTEGER PRIMARY KEY AUTOINCREMENT, quando TEXT NOT NULL, usuario TEXT NOT NULL, acao TEXT NOT NULL, detalhe TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS arquivos (id TEXT PRIMARY KEY, col TEXT NOT NULL, dono TEXT NOT NULL, categoria TEXT NOT NULL, nome TEXT NOT NULL, tipo TEXT NOT NULL, tamanho INTEGER NOT NULL, dados TEXT NOT NULL, criado_por TEXT NOT NULL, criado_em TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS arquivos_dono ON arquivos (col, dono);`,
  pg: `
    CREATE TABLE IF NOT EXISTS records (seq BIGSERIAL, col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (col, id));
    CREATE TABLE IF NOT EXISTS credenciais (user_id TEXT PRIMARY KEY, hash TEXT NOT NULL, salt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessoes (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expira BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS historico (id BIGSERIAL PRIMARY KEY, quando TEXT NOT NULL, usuario TEXT NOT NULL, acao TEXT NOT NULL, detalhe TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS arquivos (id TEXT PRIMARY KEY, col TEXT NOT NULL, dono TEXT NOT NULL, categoria TEXT NOT NULL, nome TEXT NOT NULL, tipo TEXT NOT NULL, tamanho INTEGER NOT NULL, dados TEXT NOT NULL, criado_por TEXT NOT NULL, criado_em TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS arquivos_dono ON arquivos (col, dono);`,
};

// Consultas comuns aos dois bancos, a partir de uma função exec(sql, params) -> linhas.
function queries(exec, dialect) {
  const order = dialect === "pg" ? "seq" : "rowid";
  const parse = (rows) => rows.map((r) => JSON.parse(r.data));
  return {
    all: async (col) => parse(await exec(`SELECT data FROM records WHERE col = ? ORDER BY ${order}`, [col])),
    get: async (col, id) => { const r = await exec("SELECT data FROM records WHERE col = ? AND id = ?", [col, id]); return r[0] ? JSON.parse(r[0].data) : null; },
    put: (col, id, data) => exec("INSERT INTO records (col, id, data) VALUES (?, ?, ?) ON CONFLICT (col, id) DO UPDATE SET data = excluded.data", [col, id, JSON.stringify(data)]),
    del: (col, id) => exec("DELETE FROM records WHERE col = ? AND id = ?", [col, id]),
    delCol: (col) => exec("DELETE FROM records WHERE col = ?", [col]),
    cred: async (uid) => (await exec("SELECT hash, salt FROM credenciais WHERE user_id = ?", [uid]))[0] || null,
    putCred: (uid, hash, salt) => exec("INSERT INTO credenciais (user_id, hash, salt) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, salt = excluded.salt", [uid, hash, salt]),
    delCred: (uid) => exec("DELETE FROM credenciais WHERE user_id = ?", [uid]),
    sess: async (token) => { const r = (await exec("SELECT user_id, expira FROM sessoes WHERE token = ?", [token]))[0]; return r ? { user_id: r.user_id, expira: Number(r.expira) } : null; },
    putSess: (token, uid, expira) => exec("INSERT INTO sessoes (token, user_id, expira) VALUES (?, ?, ?)", [token, uid, expira]),
    delSess: (token) => exec("DELETE FROM sessoes WHERE token = ?", [token]),
    delUserSess: (uid) => exec("DELETE FROM sessoes WHERE user_id = ?", [uid]),
    purgeSess: (now) => exec("DELETE FROM sessoes WHERE expira < ?", [now]),
    log: async (quando, usuario, acao, detalhe) => Number((await exec("INSERT INTO historico (quando, usuario, acao, detalhe) VALUES (?, ?, ?, ?) RETURNING id", [quando, usuario, acao, detalhe]))[0].id),
    // Arquivos (conteúdo em base64; metadados listados sem o conteúdo).
    arqPut: (a) => exec("INSERT INTO arquivos (id, col, dono, categoria, nome, tipo, tamanho, dados, criado_por, criado_em, tipo_doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [a.id, a.col, a.dono, a.categoria, a.nome, a.tipo, a.tamanho, a.dados, a.criado_por, a.criado_em, a.tipo_doc || "Outros"]),
    arqList: async (col, dono) => (await exec("SELECT id, col, dono, categoria, nome, tipo, tamanho, criado_por, criado_em, tipo_doc FROM arquivos WHERE col = ? AND dono = ? ORDER BY criado_em DESC", [col, dono])).map((a) => ({ ...a, tamanho: Number(a.tamanho) })),
    arqCount: async (col) => (await exec("SELECT dono, COUNT(*) AS n FROM arquivos WHERE col = ? AND categoria = 'documento' GROUP BY dono", [col])).reduce((o, r) => ((o[r.dono] = Number(r.n)), o), {}),
    arqGet: async (id) => (await exec("SELECT * FROM arquivos WHERE id = ?", [id]))[0] || null,
    arqMeta: async (id) => (await exec("SELECT id, col, dono, categoria, nome, tipo, tamanho FROM arquivos WHERE id = ?", [id]))[0] || null,
    arqDel: (id) => exec("DELETE FROM arquivos WHERE id = ?", [id]),
    arqDelDono: (col, dono) => exec("DELETE FROM arquivos WHERE col = ? AND dono = ?", [col, dono]),
    hist: async () => (await exec("SELECT id, quando, usuario, acao, detalhe FROM historico ORDER BY id DESC LIMIT 500", [])).map((h) => ({ ...h, id: Number(h.id) })),
  };
}

function sqliteStore(file) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;" + SCHEMA.sqlite);
  try { db.exec("ALTER TABLE arquivos ADD COLUMN tipo_doc TEXT"); } catch { /* coluna já existe */ }
  const exec = async (sql, params) => {
    const st = db.prepare(sql);
    return /^\s*(SELECT|INSERT[\s\S]*RETURNING)/i.test(sql) ? st.all(...params) : (st.run(...params), []);
  };
  let lock = Promise.resolve();
  return {
    dialect: "sqlite",
    ...queries(exec, "sqlite"),
    // Transações em série: o SQLite tem uma única conexão.
    tx(fn) {
      const run = lock.then(async () => {
        db.exec("BEGIN");
        try { const r = await fn(this); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
      });
      lock = run.catch(() => {});
      return run;
    },
  };
}

function pgStore(url) {
  const { Pool } = require("pg");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: process.env.PG_SSL_NO_VERIFY !== "1" } });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const execOn = (client) => async (sql, params) => (await client.query(toPg(sql), params)).rows;
  const ready = pool.query(SCHEMA.pg).then(() => pool.query("ALTER TABLE arquivos ADD COLUMN IF NOT EXISTS tipo_doc TEXT"));
  const exec = async (sql, params) => { await ready; return execOn(pool)(sql, params); };
  return {
    dialect: "pg",
    ...queries(exec, "pg"),
    async tx(fn) {
      await ready;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await fn({ dialect: "pg", ...queries(execOn(client), "pg") });
        await client.query("COMMIT");
        return r;
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
      finally { client.release(); }
    },
  };
}

function openStore() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return pgStore(url);
  if (process.env.VERCEL) return null; // na Vercel o disco é temporário: exige Postgres
  return sqliteStore(process.env.DB_PATH || path.join(__dirname, "..", "data", "mantra.db"));
}

module.exports = { openStore };
