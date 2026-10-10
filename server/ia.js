// Classificação de documentos recebidos por e-mail com o Claude (Anthropic).
// Variável: ANTHROPIC_API_KEY.
const Anthropic = require("@anthropic-ai/sdk");

const MODELO = "claude-opus-5-5";
// Preço por milhão de tokens (US$), para o painel de custos.
const PRECO = { entrada: 4, saida: 20, cacheLeitura: 0.2, cacheEscrita: 5 };
const configurado = () => !!process.env.ANTHROPIC_API_KEY;
let cliente = null;
const api = () => (cliente ||= new Anthropic());

const TIPOS = ["nota_fiscal", "boleto", "contrato", "comprovante_pagamento", "orcamento", "cobranca", "outro", "irrelevante"];
const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["tipo", "direcao", "resumo", "emitente_nome", "emitente_documento", "destinatario_documento", "numero", "valor", "vencimento", "competencia", "influenciador", "campanha"],
  properties: {
    tipo: { type: "string", enum: TIPOS },
    direcao: { type: "string", enum: ["a_pagar", "a_receber", "informativo"], description: "a_pagar quando a Mantra deve pagar; a_receber quando alguém deve à Mantra" },
    resumo: { type: "string", description: "uma frase em português" },
    emitente_nome: { type: "string" },
    emitente_documento: { type: "string", description: "CNPJ ou CPF do emitente, só dígitos; vazio se não houver" },
    destinatario_documento: { type: "string", description: "só dígitos; vazio se não houver" },
    numero: { type: "string", description: "número da nota, boleto ou contrato; vazio se não houver" },
    valor: { type: "number", description: "valor total em reais; 0 se não houver" },
    vencimento: { type: "string", description: "AAAA-MM-DD; vazio se não houver" },
    competencia: { type: "string", description: "AAAA-MM do serviço ou emissão; vazio se não houver" },
    influenciador: { type: "string", description: "nome ou @ do influenciador, se o documento for de um; senão vazio" },
    campanha: { type: "string", description: "campanha ou cliente citado; vazio se não houver" },
  },
};

const SISTEMA = `Você analisa e-mails recebidos pela Mantra, agência de marketing 360 (CNPJ próprio aparece como destinatário/tomador).
Classifique o documento principal do e-mail (anexos têm prioridade sobre o texto) e extraia os campos.
"irrelevante" é para newsletters, propaganda e conversas sem documento financeiro ou contratual.
Notas fiscais de serviço (NFS-e) e de produto (NF-e, XML) são "nota_fiscal". Use vazio ou 0 quando o dado não existir; nunca invente.`;

// anexos: [{ nome, tipo, conteudo: Buffer }]
async function classificar({ caixa, de, assunto, texto, anexos }) {
  const blocos = [];
  for (const a of anexos.slice(0, 5)) {
    if (a.tipo === "application/pdf") blocos.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.conteudo.toString("base64") }, title: a.nome });
    else if (/^image\/(png|jpeg|webp|gif)$/.test(a.tipo)) blocos.push({ type: "image", source: { type: "base64", media_type: a.tipo, data: a.conteudo.toString("base64") } });
    else if (/xml|text/.test(a.tipo) || /\.xml$/i.test(a.nome)) blocos.push({ type: "text", text: `Anexo ${a.nome}:\n${a.conteudo.toString("utf8").slice(0, 20000)}` });
  }
  blocos.push({ type: "text", text: `Caixa: ${caixa}\nDe: ${de}\nAssunto: ${assunto}\n\nTexto do e-mail:\n${texto || "(vazio)"}` });
  const r = await api().beta.messages.create({
    model: MODELO, max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SISTEMA,
    messages: [{ role: "user", content: blocos }],
  });
  if (r.stop_reason === "refusal") throw new Error("A IA recusou analisar este e-mail");
  const t = r.content.find((b) => b.type === "text");
  if (!t) throw new Error("Resposta da IA sem conteúdo");
  return { dados: JSON.parse(t.text), uso: uso(r) };
}

// Consumo de tokens e custo estimado (US$) de uma resposta.
function uso(r) {
  const u = r.usage || {};
  const t = { entrada: u.input_tokens || 0, saida: u.output_tokens || 0, cacheLeitura: u.cache_read_input_tokens || 0, cacheEscrita: u.cache_creation_input_tokens || 0 };
  const custoUsd = Object.keys(PRECO).reduce((s, k) => s + (t[k] * PRECO[k]) / 1e6, 0);
  return { modelo: r.model || MODELO, ...t, custoUsd: Math.round(custoUsd * 1e6) / 1e6 };
}

module.exports = { configurado, classificar, MODELO, PRECO, TIPOS };
