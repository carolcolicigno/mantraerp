// Acesso ao Gmail e ao Google Drive com uma conta de serviço do Google Workspace
// (delegação em todo o domínio: a conta de serviço age em nome de cada caixa monitorada).
// Variáveis: GOOGLE_SERVICE_ACCOUNT (JSON da chave, puro ou em base64).
const crypto = require("node:crypto");

class GoogleError extends Error {}

let conta = null;
function credencial() {
  if (conta) return conta;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try { conta = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")); }
  catch { throw new GoogleError("GOOGLE_SERVICE_ACCOUNT inválida: cole o JSON da chave da conta de serviço"); }
  return conta;
}
const configurado = () => !!process.env.GOOGLE_SERVICE_ACCOUNT;

const ESCOPOS = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
  drive: "https://www.googleapis.com/auth/drive",
};
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Token de acesso por (usuário, escopo), reaproveitado até perto de expirar.
const tokens = new Map();
async function token(usuario, escopo) {
  const chave = `${usuario}|${escopo}`;
  const t = tokens.get(chave);
  if (t && t.expira > Date.now() + 60e3) return t.valor;
  const sa = credencial();
  if (!sa) throw new GoogleError("Integração com o Google não configurada (GOOGLE_SERVICE_ACCOUNT)");
  const agora = Math.floor(Date.now() / 1000);
  const corpo = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, sub: usuario, scope: ESCOPOS[escopo], aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600 }))}`;
  const jwt = `${corpo}.${b64url(crypto.sign("RSA-SHA256", Buffer.from(corpo), sa.private_key))}`;
  const r = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new GoogleError(`Google recusou o acesso a ${usuario} (${j.error_description || j.error || r.status}). Confira a delegação em todo o domínio no Admin do Workspace.`);
  tokens.set(chave, { valor: j.access_token, expira: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

async function call(usuario, escopo, url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${await token(usuario, escopo)}`, ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new GoogleError(`Google: ${j.error?.message || `erro ${r.status}`}`);
  return j;
}

/* ---------- Gmail ---------- */
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
async function listarMensagens(caixa, q, max = 20) {
  const j = await call(caixa, "gmail", `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(max) })}`);
  return (j.messages || []).map((m) => m.id);
}
const decodifica = (d) => Buffer.from(String(d || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
const textoDeHtml = (h) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

// Lê uma mensagem: cabeçalhos, texto e a lista de anexos (sem o conteúdo).
async function lerMensagem(caixa, id) {
  const m = await call(caixa, "gmail", `${GMAIL}/messages/${id}?format=full`);
  const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  let texto = "", html = "";
  const anexos = [];
  const visita = (p) => {
    if (!p) return;
    if (p.filename && (p.body?.attachmentId || p.body?.data)) anexos.push({ nome: p.filename, tipo: (p.mimeType || "").toLowerCase(), tamanho: p.body.size || 0, attachmentId: p.body.attachmentId, data: p.body.data });
    else if (p.mimeType === "text/plain" && p.body?.data) texto += decodifica(p.body.data).toString("utf8");
    else if (p.mimeType === "text/html" && p.body?.data) html += decodifica(p.body.data).toString("utf8");
    (p.parts || []).forEach(visita);
  };
  visita(m.payload);
  return {
    id: m.id, threadId: m.threadId, de: h.from || "", para: h.to || "", assunto: h.subject || "(sem assunto)",
    data: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString(),
    texto: (texto || textoDeHtml(html)).slice(0, 8000), anexos,
  };
}
async function baixarAnexo(caixa, msgId, anexo) {
  if (anexo.data) return decodifica(anexo.data);
  const j = await call(caixa, "gmail", `${GMAIL}/messages/${msgId}/attachments/${anexo.attachmentId}`);
  return decodifica(j.data);
}

const cabecalho = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
async function enviarEmail(remetente, { para, assunto, html }) {
  const msg = [`From: Mantra <${remetente}>`, `To: ${para}`, `Subject: ${cabecalho(assunto)}`, "MIME-Version: 1.0", "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(html).toString("base64")].join("\r\n");
  return call(remetente, "gmail", `${GMAIL}/messages/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: b64url(msg) }) });
}

/* ---------- Drive ---------- */
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const pastas = new Map(); // cache "pai/nome" -> id
const aspas = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
async function pasta(usuario, pai, nome) {
  nome = String(nome).replace(/[\/\\]/g, "-").trim().slice(0, 120) || "Sem nome";
  const chave = `${pai}/${nome}`;
  if (pastas.has(chave)) return pastas.get(chave);
  const q = `'${aspas(pai)}' in parents and name = '${aspas(nome)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const achada = await call(usuario, "drive", `${DRIVE}?${new URLSearchParams({ q, fields: "files(id)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" })}`);
  const id = achada.files?.[0]?.id || (await call(usuario, "drive", `${DRIVE}?supportsAllDrives=true&fields=id`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nome, mimeType: "application/vnd.google-apps.folder", parents: [pai] }),
  })).id;
  pastas.set(chave, id);
  return id;
}
// Garante o caminho de pastas a partir da raiz e devolve o id da última.
async function caminho(usuario, raiz, partes) {
  let id = raiz;
  for (const p of partes) id = await pasta(usuario, id, p);
  return id;
}
async function subirArquivo(usuario, pastaId, nome, tipo, conteudo) {
  const limite = "mantra" + crypto.randomBytes(8).toString("hex");
  const corpo = Buffer.concat([
    Buffer.from(`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: nome, parents: [pastaId] })}\r\n--${limite}\r\nContent-Type: ${tipo || "application/octet-stream"}\r\n\r\n`),
    conteudo, Buffer.from(`\r\n--${limite}--`),
  ]);
  return call(usuario, "drive", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink", {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${limite}` }, body: corpo,
  });
}
const linkPasta = (id) => `https://drive.google.com/drive/folders/${id}`;

module.exports = { configurado, GoogleError, listarMensagens, lerMensagem, baixarAnexo, enviarEmail, caminho, subirArquivo, linkPasta };
