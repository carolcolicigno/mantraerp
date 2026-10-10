// Automação de e-mails: lê as caixas monitoradas, classifica anexos com IA, arquiva no Drive,
// anexa ao cadastro certo e cria itens na Caixa de e-mails do ERP. Também envia lembretes de cobrança.
// Variáveis: CAIXAS_EMAIL, DRIVE_PASTA_RAIZ, DRIVE_USUARIO, EMAIL_REMETENTE.
const crypto = require("node:crypto");
const google = require("./google");
const ia = require("./ia");

const CAIXAS = () => (process.env.CAIXAS_EMAIL || "financeiro@agenciamantra.com.br,influenciadores@agenciamantra.com.br").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const areaDaCaixa = (c) => (c.startsWith("influenciador") ? "influenciadores" : "financeiro");
const REMETENTE = () => process.env.EMAIL_REMETENTE || CAIXAS().find((c) => c.startsWith("financeiro")) || CAIXAS()[0];
const digitos = (v) => String(v || "").replace(/\D/g, "");
const MAX_ANEXO = 3 * 1024 * 1024;
const ACEITOS = /^(application\/pdf|image\/(png|jpeg|webp)|application\/xml|text\/xml|text\/plain)$/;
const NOME_TIPO = { nota_fiscal: "Notas fiscais", boleto: "Boletos", contrato: "Contratos", comprovante_pagamento: "Comprovantes", orcamento: "Orçamentos", cobranca: "Cobranças", outro: "Outros" };
const TIPO_DOC = { nota_fiscal: "Nota fiscal", boleto: "Boleto", contrato: "Contrato", comprovante_pagamento: "Comprovante", orcamento: "Orçamento", cobranca: "Cobrança", outro: "Outros" };

const status = () => ({ google: google.configurado(), ia: ia.configurado(), drive: !!process.env.DRIVE_PASTA_RAIZ, caixas: CAIXAS(), remetente: REMETENTE() });

// Acha o cadastro dono do documento: CPF/CNPJ, depois e-mail do remetente, depois nome.
function identificar(cad, d, de, area) {
  const email = (de.match(/<([^>]+)>/)?.[1] || de).trim().toLowerCase();
  const docs = [digitos(d.emitente_documento), digitos(d.destinatario_documento)].filter((x) => x.length >= 11);
  const ordem = area === "influenciadores" ? ["influenciadores", "fornecedores", "clientes"] : ["fornecedores", "clientes", "influenciadores"];
  for (const col of ordem) {
    const r = cad[col].find((x) => docs.includes(digitos(x.cnpj || x.cpfCnpj)) && digitos(x.cnpj || x.cpfCnpj).length >= 11);
    if (r) return { col, id: r.id, nome: r.nome };
  }
  for (const col of ordem) {
    const r = cad[col].find((x) => [x.contato, x.emailFinanceiro, x.email].some((e) => e && e.toLowerCase() === email));
    if (r) return { col, id: r.id, nome: r.nome };
  }
  const alvo = String(d.influenciador || d.emitente_nome || "").toLowerCase().replace(/^@/, "");
  if (alvo.length >= 3) for (const col of ordem) {
    const r = cad[col].find((x) => [x.nome, x.razaoSocial, x.arroba].some((n) => n && (n.toLowerCase().replace(/^@/, "").includes(alvo) || alvo.includes(n.toLowerCase().replace(/^@/, "")))));
    if (r) return { col, id: r.id, nome: r.nome };
  }
  return null;
}

// Processa mensagens novas de todas as caixas. ctx: { store, log }. Limita o lote para caber no tempo da função.
async function sincronizar(ctx, { limite = 12 } = {}) {
  if (!google.configurado()) throw new google.GoogleError("Integração com o Google não configurada (GOOGLE_SERVICE_ACCOUNT)");
  if (!ia.configurado()) throw new Error("Chave da IA não configurada (ANTHROPIC_API_KEY)");
  const { store } = ctx;
  const cad = { fornecedores: await store.all("fornecedores"), clientes: await store.all("clientes"), influenciadores: await store.all("influenciadores") };
  const novos = [], erros = [];
  let restante = limite;
  for (const caixa of CAIXAS()) {
    if (restante <= 0) break;
    const area = areaDaCaixa(caixa);
    const estado = (await store.get("config", `inbox-${caixa}`)) || { id: `inbox-${caixa}` };
    // Primeira leitura: últimos 30 dias. Depois, a partir da última verificação (com folga de 1 dia).
    const desde = estado.ultima ? Math.floor(new Date(estado.ultima).getTime() / 1000) - 86400 : Math.floor(Date.now() / 1000) - 30 * 86400;
    const inicio = new Date().toISOString();
    let ids;
    try { ids = await google.listarMensagens(caixa, `after:${desde} -in:sent -in:chats -category:promotions -category:social`, 50); }
    catch (e) { erros.push(`${caixa}: ${e.message}`); continue; }
    let completo = true;
    for (const mid of ids.reverse()) {
      if (await store.get("emails", `gm-${mid}`)) continue;
      if (restante-- <= 0) { completo = false; break; }
      try { const item = await processar(ctx, caixa, area, mid, cad); if (item) novos.push(item); }
      catch (e) { erros.push(`${caixa}: ${e.message}`); completo = false; }
    }
    if (completo) await store.put("config", estado.id, { ...estado, ultima: inicio });
  }
  await store.put("config", "inbox-status", { id: "inbox-status", ultimaSync: new Date().toISOString(), erros: erros.slice(0, 5) });
  return { novos, erros, pendentes: restante < 0 };
}

async function processar(ctx, caixa, area, mid, cad) {
  const { store } = ctx;
  const m = await google.lerMensagem(caixa, mid);
  const anexos = [];
  for (const a of m.anexos) {
    const tipo = /\.xml$/i.test(a.nome) ? "application/xml" : a.tipo;
    if (!ACEITOS.test(tipo) || a.tamanho > 20 * 1024 * 1024) continue;
    anexos.push({ nome: a.nome, tipo, conteudo: await google.baixarAnexo(caixa, mid, a) });
  }
  // Sem anexo e sem cara de documento: só registra como lido, sem gastar IA.
  const pareceDoc = /nota|nf-?e|nfs|fatura|boleto|cobran|contrato|pagamento|comprovante|recibo|invoice|or[cç]amento|pix/i.test(m.assunto + " " + m.texto.slice(0, 1500));
  const base = { id: `gm-${mid}`, caixa, area, de: m.de, assunto: m.assunto.slice(0, 300), data: m.data, recebidoEm: new Date().toISOString(), _rev: 1 };
  if (!anexos.length && !pareceDoc) { await store.put("emails", base.id, { ...base, tipo: "irrelevante", status: "ignorado", resumo: "" }); return null; }

  const { dados: d, uso } = await ia.classificar({ caixa, de: m.de, assunto: m.assunto, texto: m.texto, anexos });
  await store.put("consumo", `ia-${mid}`, { id: `ia-${mid}`, data: new Date().toISOString(), api: "Anthropic (Claude)", operacao: "Classificar e-mail", ref: m.assunto.slice(0, 120), ...uso });
  if (d.tipo === "irrelevante") { await store.put("emails", base.id, { ...base, tipo: "irrelevante", status: "ignorado", resumo: d.resumo }); return null; }

  const dono = identificar(cad, d, m.de, area);
  const item = {
    ...base, tipo: d.tipo, direcao: d.direcao, resumo: d.resumo, emitente: d.emitente_nome, documento: digitos(d.emitente_documento),
    numero: d.numero, valor: Number(d.valor) || 0, vencimento: /^\d{4}-\d{2}-\d{2}$/.test(d.vencimento) ? d.vencimento : "",
    competencia: d.competencia, influenciador: d.influenciador, campanha: d.campanha, entidade: dono, status: "novo", anexos: [],
  };

  // Drive: Mantra ERP / <área> / <tipo de cadastro> / <nome> / <tipo do doc> / <AAAA-MM>
  const raiz = process.env.DRIVE_PASTA_RAIZ;
  const usuarioDrive = process.env.DRIVE_USUARIO || caixa;
  let pastaId = null;
  if (raiz && anexos.length) {
    const grupo = dono ? { fornecedores: "Fornecedores", clientes: "Clientes", influenciadores: "Influenciadores" }[dono.col] : "Não identificados";
    const mes = (item.competencia && /^\d{4}-\d{2}$/.test(item.competencia) ? item.competencia : m.data.slice(0, 7));
    pastaId = await google.caminho(usuarioDrive, raiz, [area === "influenciadores" ? "Influenciadores" : "Financeiro", grupo, dono?.nome || d.emitente_nome || "Sem remetente", NOME_TIPO[d.tipo] || "Outros", mes]);
    item.drivePasta = google.linkPasta(pastaId);
  }
  for (const a of anexos) {
    const anexo = { nome: a.nome.slice(0, 150), tipo: a.tipo };
    if (pastaId) { try { anexo.drive = (await google.subirArquivo(usuarioDrive, pastaId, a.nome, a.tipo, a.conteudo)).webViewLink; } catch (e) { anexo.erroDrive = e.message; } }
    if (a.conteudo.length <= MAX_ANEXO) {
      // Guarda no ERP: no cadastro identificado ou, se não houver, só na caixa de e-mails.
      const arq = { id: crypto.randomBytes(12).toString("hex"), col: dono?.col || "emails", dono: dono?.id || item.id, categoria: "documento", nome: anexo.nome, tipo: a.tipo === "application/xml" ? "text/plain" : a.tipo, tamanho: a.conteudo.length, dados: a.conteudo.toString("base64"), criado_por: `E-mail ${caixa}`, criado_em: new Date().toISOString(), tipo_doc: TIPO_DOC[d.tipo] || "Outros" };
      await store.arqPut(arq);
      anexo.arqId = arq.id;
    }
    item.anexos.push(anexo);
  }
  await store.put("emails", item.id, item);
  await ctx.log("Automação de e-mails", `${NOME_TIPO[d.tipo] || d.tipo}: ${dono?.nome || d.emitente_nome || m.de}${item.valor ? ` — R$ ${item.valor.toFixed(2)}` : ""}`);
  return item;
}

/* ---------- Lembretes de cobrança ---------- */
const BRL = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmt = (d) => d.split("-").reverse().join("/");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const somaDias = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// Envia 3 dias antes do vencimento e 1 dia depois (se não pago). Cada aviso sai uma única vez.
async function enviarLembretes(ctx) {
  if (!google.configurado()) return { enviados: 0 };
  const { store } = ctx;
  const cfg = (await store.get("config", "geral")) || {};
  if (!cfg.lembretesAtivos) return { enviados: 0, desligado: true };
  const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const clientes = await store.all("clientes");
  let enviados = 0;
  for (const c of await store.all("contas")) {
    if (c.tipo !== "receber" || c.status === "pago" || !c.aprovado) continue;
    const tipo = c.vencimento === somaDias(hoje, 3) ? "antes" : c.vencimento === somaDias(hoje, -1) ? "atraso" : null;
    if (!tipo || (c.lembretes || []).some((l) => l.tipo === tipo)) continue;
    const cli = clientes.find((x) => x.nome === c.parceiro);
    const para = [cli?.emailFinanceiro, cli?.contato].find((e) => /@/.test(e || ""));
    if (!para) continue;
    const link = c.asaas?.url ? `<p><a href="${esc(c.asaas.url)}">Acessar boleto / Pix</a></p>` : "";
    const assunto = tipo === "antes" ? `Lembrete: ${c.descricao} vence em ${fmt(c.vencimento)}` : `Pagamento em aberto: ${c.descricao}`;
    const html = `<p>Olá${cli.contatoNome ? `, ${esc(cli.contatoNome.split(" ")[0])}` : ""}!</p>
      <p>${tipo === "antes" ? "Passando para lembrar do vencimento abaixo:" : "Não identificamos o pagamento abaixo, vencido ontem:"}</p>
      <p><b>${esc(c.descricao)}</b><br>Valor: ${BRL(c.valor)}<br>Vencimento: ${fmt(c.vencimento)}${c.nota ? `<br>Nota fiscal: ${esc(c.nota)}` : ""}</p>${link}
      <p>${tipo === "atraso" ? "Se já pagou, por favor desconsidere e nos envie o comprovante. " : ""}Qualquer dúvida, é só responder este e-mail.</p><p>Equipe Mantra</p>`;
    try {
      await google.enviarEmail(REMETENTE(), { para, assunto, html });
      c.lembretes = [...(c.lembretes || []), { tipo, data: hoje, para }];
      c._rev = (Number(c._rev) || 0) + 1;
      await store.put("contas", c.id, c);
      await store.put("consumo", `gm-envio-${c.id}-${tipo}`, { id: `gm-envio-${c.id}-${tipo}`, data: new Date().toISOString(), api: "Google (Gmail)", operacao: "Lembrete de cobrança", ref: c.descricao, entrada: 0, saida: 0, custoUsd: 0 });
      await ctx.log("Lembrete enviado", `${c.parceiro}: ${c.descricao} (${para})`);
      enviados++;
    } catch (e) { await ctx.log("Falha no lembrete", `${c.parceiro}: ${e.message}`); }
  }
  return { enviados };
}

module.exports = { status, sincronizar, enviarLembretes, areaDaCaixa };
