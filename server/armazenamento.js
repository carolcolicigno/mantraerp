// Onde ficam os documentos: no Google Drive quando a integração está configurada
// (o banco guarda só os metadados), ou no próprio banco como reserva. Também faz os backups.
const google = require("./google");

const NOME_COL = { clientes: "Clientes", fornecedores: "Fornecedores", contratos: "Contratos", colaboradores: "Pessoas", projetos: "Projetos", concorrencias: "Concorrências", influenciadores: "Influenciadores", influContratos: "Contratos de influenciadores", emails: "Caixa de e-mails" };
const usuario = () => process.env.DRIVE_USUARIO || (process.env.CAIXAS_EMAIL || "financeiro@agenciamantra.com.br").split(",")[0].trim();
const noDrive = () => google.configurado() && !!process.env.DRIVE_PASTA_RAIZ;

// Grava o arquivo; documentos vão para o Drive em "Arquivos do ERP/<cadastro>/<nome>".
async function guardar(store, a, conteudo, donoNome = "") {
  if (a.categoria === "documento" && noDrive()) {
    try {
      const pasta = await google.caminho(usuario(), process.env.DRIVE_PASTA_RAIZ, ["Arquivos do ERP", NOME_COL[a.col] || a.col, donoNome || a.dono]);
      const f = await google.subirArquivo(usuario(), pasta, a.nome, a.tipo, conteudo);
      return store.arqPut({ ...a, dados: "", drive_id: f.id });
    } catch (e) { console.error("Drive indisponível, guardando no banco:", e.message); }
  }
  return store.arqPut({ ...a, dados: conteudo.toString("base64") });
}
const ler = async (a) => (a.drive_id ? google.baixarArquivo(usuario(), a.drive_id) : Buffer.from(a.dados, "base64"));
async function apagar(store, a) {
  if (a.drive_id) await google.lixeira(usuario(), a.drive_id).catch(() => {});
  await store.arqDel(a.id);
}

// Move documentos antigos do banco para o Drive, em lotes (cabe no tempo de uma função).
async function migrar(store, nomeDono, limite = 25) {
  if (!noDrive()) throw new google.GoogleError("Configure o Google Drive (GOOGLE_SERVICE_ACCOUNT e DRIVE_PASTA_RAIZ) antes de mover os arquivos");
  let movidos = 0;
  for (const id of await store.arqNoBanco(limite)) {
    const a = await store.arqGet(id);
    const pasta = await google.caminho(usuario(), process.env.DRIVE_PASTA_RAIZ, ["Arquivos do ERP", NOME_COL[a.col] || a.col, (await nomeDono(a.col, a.dono)) || a.dono]);
    const f = await google.subirArquivo(usuario(), pasta, a.nome, a.tipo, Buffer.from(a.dados, "base64"));
    await store.arqMoverDrive(a.id, f.id);
    movidos++;
  }
  return { movidos, restantes: (await store.arqNoBanco(1)).length > 0 };
}

// Backup: todos os registros (sem o conteúdo dos arquivos) em JSON.
async function gerarBackup(store) {
  const registros = await store.dump();
  const out = { geradoEm: new Date().toISOString(), versao: 1, colecoes: {} };
  for (const r of registros) {
    if (r.col === "config" && r.id !== "geral") continue;
    (out.colecoes[r.col] ||= []).push(r.data);
  }
  return out;
}
async function backupNoDrive(store) {
  if (!noDrive()) return { ok: false, motivo: "Drive não configurado" };
  const dados = Buffer.from(JSON.stringify(await gerarBackup(store)));
  const pasta = await google.caminho(usuario(), process.env.DRIVE_PASTA_RAIZ, ["Backups do ERP"]);
  const nome = `mantra-erp-${new Date().toISOString().slice(0, 10)}.json`;
  await google.subirArquivo(usuario(), pasta, nome, "application/json", dados);
  return { ok: true, nome, bytes: dados.length };
}

module.exports = { noDrive, guardar, ler, apagar, migrar, gerarBackup, backupNoDrive };
