// Alertas para a equipe: sempre como notificação no app (e no navegador, com o ERP aberto) e,
// se configurado, também no WhatsApp.
// WhatsApp (API oficial da Meta): WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_PARA (números com DDI, separados por vírgula)
// e, opcionalmente, WHATSAPP_TEMPLATE (modelo aprovado com 1 variável de texto; sem ele a Meta só entrega
// texto livre a quem falou com o número nas últimas 24 h).
const crypto = require("node:crypto");
const canais = () => ({ whatsapp: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_PARA) });
async function whatsapp(texto) {
  const url = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  const tpl = process.env.WHATSAPP_TEMPLATE;
  for (const para of process.env.WHATSAPP_PARA.split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean)) {
    const corpo = tpl
      ? { messaging_product: "whatsapp", to: para, type: "template", template: { name: tpl, language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: texto.replace(/\s*\n\s*/g, " · ").slice(0, 1000) }] }] } }
      : { messaging_product: "whatsapp", to: para, type: "text", text: { body: texto.slice(0, 4000) } };
    const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(`WhatsApp: ${j.error?.message || `erro ${r.status}`}`); }
  }
}

// Grava a notificação no app (área: financeiro, influenciadores ou geral) e manda no WhatsApp se ligado.
async function notificar(store, { titulo, texto, area = "geral", modulo = "", whatsappLigado = false }) {
  const n = { id: `n-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`, data: new Date().toISOString(), titulo: String(titulo).slice(0, 140), texto: String(texto || "").slice(0, 2000), area, modulo };
  await store.put("notificacoes", n.id, n);
  const erros = [];
  if (whatsappLigado && canais().whatsapp) await whatsapp(`*${n.titulo}*\n${n.texto}`).catch((e) => erros.push(e.message));
  return { notificacao: n, erros };
}
const enviarWhatsapp = (texto) => whatsapp(texto);

const BRL = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmt = (d) => String(d || "").split("-").reverse().join("/");
const somaDias = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// Resumo diário: vencimentos, atrasos, aprovações e documentos novos.
async function resumoDiario(store) {
  const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const contas = (await store.all("contas")).filter((c) => c.status !== "pago");
  const pagarHoje = contas.filter((c) => c.tipo === "pagar" && c.aprovado && c.vencimento >= hoje && c.vencimento <= somaDias(hoje, 1));
  const atrasoRec = contas.filter((c) => c.tipo === "receber" && c.vencimento < hoje);
  const aprovar = contas.filter((c) => c.tipo === "pagar" && !c.aprovado).length + (await store.all("compras")).filter((p) => ["solicitado", "cotação"].includes(p.status)).length;
  const docs = (await store.all("emails")).filter((e) => e.status === "novo" && !e.exemplo).length;
  const linhas = [`*Mantra ERP — resumo de ${fmt(hoje)}*`];
  if (pagarHoje.length) linhas.push(`💸 A pagar hoje/amanhã: ${pagarHoje.length} (${BRL(pagarHoje.reduce((s, c) => s + Number(c.valor), 0))})`, ...pagarHoje.slice(0, 5).map((c) => `   • ${c.descricao} — ${BRL(c.valor)} (${fmt(c.vencimento)})`));
  if (atrasoRec.length) linhas.push(`⚠️ Recebimentos atrasados: ${atrasoRec.length} (${BRL(atrasoRec.reduce((s, c) => s + Number(c.valor), 0))})`);
  if (aprovar) linhas.push(`✅ Aprovações pendentes: ${aprovar}`);
  if (docs) linhas.push(`📥 Documentos novos na Caixa de e-mails: ${docs}`);
  if (linhas.length === 1) return null;
  return linhas.join("\n");
}

module.exports = { canais, notificar, enviarWhatsapp, resumoDiario, BRL };
