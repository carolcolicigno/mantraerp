/* Kanban de projetos — lê e grava no banco via erp.js (db, render, openForm, log). */

const TAG_COLORS = [["#fdf1e3", "#8a4b10"], ["#e3effc", "#1f4f8a"], ["#fde6f3", "#8a1f5c"], ["#ece7fb", "#4b2a8a"], ["#e3f6e6", "#1c6b27"]];
const PROJECT_TINTS = ["#fde6f3", "#e3effc", "#ece7fb", "#fdf1e3", "#e3f6e6"];
const TIPO_ICON = { App: "📱", Website: "🖥️", WebApp: "💻", Campanha: "📣", Conteúdo: "✍️" };
const PROJECT_STATUS = { ativo: "Ativos", pausado: "Pausados", encerrado: "Encerrados" };

const COLUMNS = [
  { id: "todo", label: "A FAZER", color: "var(--todo)" },
  { id: "progress", label: "EM ANDAMENTO", color: "var(--progress)" },
  { id: "review", label: "EM REVISÃO", color: "var(--review)" },
  { id: "done", label: "CONCLUÍDO", color: "var(--done)" },
];

const kb = { status: "ativo", query: "", projetoId: null, view: "kanban" };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const chevron = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>';
const hashIdx = (s, n) => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % n;
const tagsOf = (t) => String(t.etiquetas || "").split(",").map((x) => x.trim()).filter(Boolean);
const initials = (nome) => String(nome || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
const projStatus = (p) => p.status || "ativo";
const projetoAtual = () => db.projetos.find((p) => p.id === kb.projetoId);
const tarefasDoProjeto = () => (db.tarefas || []).filter((t) => t.projetoId === kb.projetoId);

function renderStatusTabs() {
  $("#statusTabs").innerHTML = Object.entries(PROJECT_STATUS).map(([k, l]) => {
    const n = String(db.projetos.filter((p) => projStatus(p) === k).length).padStart(2, "0");
    return `<button role="tab" data-status="${k}" class="${kb.status === k ? "is-active" : ""}">${l}(${n})</button>`;
  }).join("");
}

function renderProjects() {
  const q = kb.query.toLowerCase();
  const lista = db.projetos.filter((p) => projStatus(p) === kb.status && `${p.nome} ${p.cliente}`.toLowerCase().includes(q));
  $("#projectList").innerHTML = lista.map((p) => `<li class="project ${p.id === kb.projetoId ? "is-active" : ""}" data-id="${esc(p.id)}">
      <span class="project__icon" style="background:${PROJECT_TINTS[hashIdx(p.id, PROJECT_TINTS.length)]}">${TIPO_ICON[p.tipo] || "📁"}</span>
      <div><div class="project__name">${esc(p.nome)}</div><div class="project__meta">${esc(p.cliente)}<b></b>${esc(p.tipo || "Projeto")}</div></div>${chevron}
    </li>`).join("") || `<li class="project__meta" style="padding:12px">Nenhum projeto encontrado</li>`;
}

function renderHeader() {
  const p = projetoAtual();
  $("#projectName").textContent = p ? p.nome : "Nenhum projeto";
  $("#crumbs").textContent = p ? `${p.cliente}/ ${p.tipo || "Projeto"}/ ${(db.tarefas || []).filter((t) => t.projetoId === p.id).length} tarefas` : "Cadastre um projeto em Projetos e serviços";
  const resp = [...new Set(tarefasDoProjeto().map((t) => t.responsavel).filter(Boolean))];
  $("#teamAvatars").innerHTML = resp.slice(0, 3).map((n) => `<span class="av av--txt" title="${esc(n)}">${esc(initials(n))}</span>`).join("") +
    (resp.length > 3 ? `<span class="av av--more">+${resp.length - 3}</span>` : "") || `<span class="crumbs">Sem responsáveis</span>`;
  $("#newBoard").disabled = !p;
}

const tagHtml = (t) => { const [bg, fg] = TAG_COLORS[hashIdx(t, TAG_COLORS.length)]; return `<span class="tag" style="background:${bg};color:${fg}">${esc(t)}</span>`; };
const foot = (t) => `<div class="card__foot">
  <span title="Comentários"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>${Number(t.comentarios) || 0}</span>
  <span title="Anexos"><svg viewBox="0 0 24 24"><path d="m20 11-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7"/></svg>${Number(t.anexos) || 0}</span>
  ${t.prazo ? `<span title="Prazo" class="${t.prazo < TODAY && t.col !== "done" ? "neg" : ""}">📅 ${fmtDate(t.prazo)}</span>` : ""}
  <span class="card__assigned">${t.responsavel ? `<span class="av av--txt" title="${esc(t.responsavel)}">${esc(initials(t.responsavel))}</span>` : "Sem responsável"}</span></div>`;

function cardHtml(t) {
  return `<article class="card" draggable="true" data-id="${esc(t.id)}">
    <div class="card__tags">${tagsOf(t).map(tagHtml).join("")}<button class="card__more" data-edit="${esc(t.id)}" aria-label="Editar tarefa"><svg viewBox="0 0 24 24" class="fill"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button></div>
    <h3 class="card__title">${esc(t.titulo)}</h3>${foot(t)}</article>`;
}

function renderBoard() {
  const board = $("#board");
  const tasks = tarefasDoProjeto();
  if (!projetoAtual()) { board.innerHTML = `<p class="empty">Selecione um projeto.</p>`; return; }
  const label = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));
  if (kb.view === "kanban") {
    board.innerHTML = `<div class="kanban">${COLUMNS.map((c) => {
      const items = tasks.filter((t) => t.col === c.id);
      return `<div class="col"><div class="col__head"><span class="dot" style="background:${c.color}"></span>${c.label}
        <span class="count">${items.length}</span><button class="col__add" data-add="${c.id}" aria-label="Adicionar tarefa">+</button></div>
        <div class="col__cards" data-col="${c.id}">${items.map(cardHtml).join("")}</div></div>`;
    }).join("")}</div>`;
  } else if (kb.view === "table") {
    board.innerHTML = tasks.length ? `<table class="table"><thead><tr><th>Tarefa</th><th>Etiquetas</th><th>Status</th><th>Responsável</th><th>Prazo</th><th></th></tr></thead><tbody>
      ${tasks.map((t) => `<tr><td>${esc(t.titulo)}</td><td>${tagsOf(t).map(tagHtml).join(" ")}</td><td>${label[t.col]}</td><td>${esc(t.responsavel || "—")}</td><td>${fmtDate(t.prazo)}</td>
        <td><div class="row-actions"><button data-edit="${esc(t.id)}">Editar</button></div></td></tr>`).join("")}</tbody></table>` : `<p class="empty">Nenhuma tarefa.</p>`;
  } else {
    board.innerHTML = `<div class="list">${tasks.map((t) => `<article class="card" data-edit="${esc(t.id)}" style="cursor:pointer"><div class="card__tags">${tagsOf(t).map(tagHtml).join("")}</div><h3 class="card__title">${esc(t.titulo)}</h3><span class="pill">${label[t.col]}</span>${foot(t)}</article>`).join("") || `<p class="empty">Nenhuma tarefa.</p>`}</div>`;
  }
}

function renderKanban() {
  if (!db) return;
  db.tarefas ||= [];
  if (!projetoAtual() || projStatus(projetoAtual()) !== kb.status) kb.projetoId = db.projetos.find((x) => projStatus(x) === kb.status)?.id || null;
  renderStatusTabs(); renderProjects(); renderHeader(); renderBoard();
}

function novaTarefa(col) {
  if (!projetoAtual()) return;
  openForm("tarefas", null, { col, projetoId: kb.projetoId, comentarios: 0, anexos: 0 });
}

// Eventos
$("#statusTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  kb.status = b.dataset.status; kb.projetoId = null; renderKanban();
});
$("#search").addEventListener("input", (e) => { kb.query = e.target.value; renderProjects(); });
$("#projectList").addEventListener("click", (e) => {
  const li = e.target.closest(".project"); if (!li) return;
  kb.projetoId = li.dataset.id; renderKanban();
});
$("#pageTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#pageTabs button").forEach((x) => x.classList.toggle("is-active", x === b));
});
$("#views").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  kb.view = b.dataset.view;
  document.querySelectorAll("#views button").forEach((x) => x.classList.toggle("is-active", x === b));
  renderBoard();
});
$("#starBtn").addEventListener("click", (e) => {
  const b = e.currentTarget; b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
});
$("#newBoard").addEventListener("click", () => novaTarefa("todo"));

const board = $("#board");
board.addEventListener("click", (e) => {
  const add = e.target.closest("[data-add]"); if (add) return novaTarefa(add.dataset.add);
  const ed = e.target.closest("[data-edit]");
  if (ed) { const t = db.tarefas.find((x) => x.id === ed.dataset.edit); if (t) openForm("tarefas", t); }
});
board.addEventListener("dragstart", (e) => {
  const c = e.target.closest(".card"); if (!c) return;
  c.classList.add("dragging"); e.dataTransfer.setData("text/plain", c.dataset.id);
});
board.addEventListener("dragend", (e) => e.target.closest(".card")?.classList.remove("dragging"));
board.addEventListener("dragover", (e) => {
  const col = e.target.closest(".col__cards"); if (!col) return;
  e.preventDefault(); col.classList.add("drag-over");
});
board.addEventListener("dragleave", (e) => e.target.closest(".col__cards")?.classList.remove("drag-over"));
board.addEventListener("drop", (e) => {
  const col = e.target.closest(".col__cards"); if (!col) return;
  e.preventDefault(); col.classList.remove("drag-over");
  const t = db.tarefas.find((x) => x.id === e.dataTransfer.getData("text/plain"));
  if (t && t.col !== col.dataset.col) {
    t.col = col.dataset.col;
    log("Tarefa movida", `${t.titulo} → ${COLUMNS.find((c) => c.id === t.col).label}`);
    render();
  }
});
