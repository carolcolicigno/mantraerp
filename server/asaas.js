// Integração com o Asaas: cobranças (boleto/Pix) e NFS-e.
// Variáveis: ASAAS_API_KEY (obrigatória), ASAAS_ENV=producao (padrão: sandbox),
// ASAAS_WEBHOOK_TOKEN (valida o webhook), ASAAS_BASE_URL (só para testes).
const configurado = () => !!process.env.ASAAS_API_KEY;
const ambiente = () => (process.env.ASAAS_ENV === "producao" ? "producao" : "sandbox");
const baseUrl = () => process.env.ASAAS_BASE_URL || (ambiente() === "producao" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3");
const digitos = (s) => String(s || "").replace(/\D/g, "");
const hoje = () => new Date().toISOString().slice(0, 10);

class AsaasError extends Error {}

async function call(method, path, body) {
  const r = await fetch(baseUrl() + path, {
    method,
    headers: { access_token: process.env.ASAAS_API_KEY, "Content-Type": "application/json", "User-Agent": "mantra-erp" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AsaasError(`Asaas: ${j.errors?.[0]?.description || `erro ${r.status}`}`);
  return j;
}

// Encontra ou cria o cliente no Asaas a partir do cadastro do ERP.
async function clienteId(cliente) {
  if (cliente.asaasId) return cliente.asaasId;
  const doc = digitos(cliente.cnpj);
  if (doc.length !== 11 && doc.length !== 14) throw new AsaasError(`Cadastre um CPF/CNPJ válido para o cliente ${cliente.nome}`);
  const achado = await call("GET", `/customers?cpfCnpj=${doc}`);
  if (achado.data?.[0]) return achado.data[0].id;
  const email = /@/.test(cliente.contato || "") ? cliente.contato : undefined;
  return (await call("POST", "/customers", { name: cliente.nome, cpfCnpj: doc, email, externalReference: cliente.id })).id;
}

const resumoCobranca = (p) => ({ id: p.id, status: p.status, url: p.invoiceUrl || "", boleto: p.bankSlipUrl || "" });

async function criarCobranca(conta, cliente) {
  const customer = await clienteId(cliente);
  const p = await call("POST", "/payments", {
    customer,
    billingType: "UNDEFINED", // o cliente escolhe boleto, Pix ou cartão na página da cobrança
    value: Number(conta.valor),
    dueDate: conta.vencimento > hoje() ? conta.vencimento : hoje(),
    description: conta.descricao,
    externalReference: conta.id,
  });
  const out = { ...resumoCobranca(p), customer };
  try { out.pix = (await call("GET", `/payments/${p.id}/pixQrCode`)).payload || ""; } catch { out.pix = ""; }
  return out;
}
const consultarCobranca = async (id) => resumoCobranca(await call("GET", `/payments/${id}`));

const resumoNota = (n) => ({ id: n.id, status: n.status, numero: n.number || "", pdf: n.pdfUrl || "", motivo: n.statusDescription || "" });

async function emitirNfse(nota, cliente, cfg) {
  if (!cfg.servicoMunicipal) throw new AsaasError("Defina o serviço municipal em Configurações antes de emitir NFS-e");
  const customer = await clienteId(cliente);
  const inv = await call("POST", "/invoices", {
    customer,
    serviceDescription: nota.descricao || `Serviços de publicidade — ${cliente.nome}`,
    observations: nota.observacoes || "",
    value: Number(nota.valor),
    deductions: 0,
    effectiveDate: hoje(),
    municipalServiceName: cfg.servicoMunicipal,
    externalReference: nota.id,
    taxes: { retainIss: false, iss: Number(cfg.iss) || 0, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0 },
  });
  // Emite imediatamente em vez de esperar a data agendada.
  const autorizada = await call("POST", `/invoices/${inv.id}/authorize`).catch(() => inv);
  return resumoNota(autorizada);
}
const consultarNota = async (id) => resumoNota(await call("GET", `/invoices/${id}`));

// Status do Asaas -> status do ERP.
const PAGO = ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"];
const NOTA = { AUTHORIZED: "emitida", ERROR: "erro", CANCELED: "cancelada", CANCELLED: "cancelada", SCHEDULED: "processando", SYNCHRONIZED: "processando", AUTHORIZATION_PENDING: "processando", PROCESSING_CANCELLATION: "processando" };

module.exports = { configurado, ambiente, criarCobranca, consultarCobranca, emitirNfse, consultarNota, AsaasError, PAGO, NOTA };
