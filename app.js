const PROJECTS = [
  { name: "ProjectFlow Pro", type: "App", area: "UI Design", status: "active", icon: "📱", tint: "#fde6f3" },
  { name: "CreativeSync Hub", type: "WebApp", area: "All", status: "active", icon: "💻", tint: "#ffffff" },
  { name: "Blueprint Nexus", type: "Website", area: "Developement", status: "active", icon: "🖥️", tint: "#e3effc" },
  { name: "VisionPlan Pro", type: "App", area: "Developement", status: "active", icon: "📱", tint: "#ece7fb" },
  { name: "CraftBoard Central", type: "Website", area: "UI Design", status: "active", icon: "💻", tint: "#fdf1e3" },
  { name: "ArtisanLink Connect", type: "App", area: "UI Design", status: "active", icon: "📱", tint: "#e3effc" },
  { name: "IdeaForge Studio", type: "Website", area: "UI Design", status: "active", icon: "🖥️", tint: "#ece7fb" },
  { name: "PixelPath Labs", type: "App", area: "Research", status: "hold", icon: "📱", tint: "#fdf1e3" },
  { name: "NovaGrid Suite", type: "Website", area: "Developement", status: "hold", icon: "💻", tint: "#e3effc" },
  { name: "Quantum Board", type: "WebApp", area: "UI Design", status: "hold", icon: "🖥️", tint: "#fde6f3" },
  { name: "Orbit Planner", type: "App", area: "UI Design", status: "closed", icon: "📱", tint: "#ece7fb" },
  { name: "Lumen Docs", type: "Website", area: "Content", status: "closed", icon: "💻", tint: "#e3effc" },
];

const TAGS = {
  "UX Design": ["#fdf1e3", "#8a4b10"], "UX Research": ["#e3effc", "#1f4f8a"],
  "Requirement Gathering": ["#fde6f3", "#8a1f5c"], "Planning": ["#ece7fb", "#4b2a8a"],
  "Wireframing": ["#ece7fb", "#4b2a8a"], "Business Insights": ["#fdf1e3", "#8a4b10"],
  "Website": ["#e3effc", "#1f4f8a"], "UI Design": ["#fdf1e3", "#8a4b10"],
};

const COLUMNS = [
  { id: "todo", label: "TO DO", color: "var(--todo)" },
  { id: "progress", label: "IN PROGRESS", color: "var(--progress)" },
  { id: "review", label: "IN REVIEW", color: "var(--review)" },
  { id: "done", label: "COMPLETED", color: "var(--done)" },
];

let tasks = [
  { col: "todo", tags: ["UX Design", "UX Research"], title: "Overall UX Process of full product for first version", thumb: "light" },
  { col: "todo", tags: ["Wireframing"], title: "DO wireframe of same product" },
  { col: "todo", tags: ["UI Design"], title: "Best UI design of product" },
  { col: "progress", tags: ["Requirement Gathering"], title: "Collect all details from client regarding project", thumb: "light" },
  { col: "progress", tags: ["Business Insights"], title: "Gather Business insights from client", thumb: "dark" },
  { col: "progress", tags: ["Planning"], title: "Define sprint goals with stakeholders" },
  { col: "progress", tags: ["UX Research"], title: "Run user interviews round two" },
  { col: "review", tags: ["Planning"], title: "Done planning of project", thumb: "light" },
  { col: "review", tags: ["Website"], title: "Second design concept" },
  { col: "review", tags: ["UI Design"], title: "Overall UX Process of full product for first version" },
  { col: "done", tags: ["Requirement Gathering"], title: "Collect all details from client regarding project", thumb: "light" },
  { col: "done", tags: ["Business Insights"], title: "Gather Business insights from client", thumb: "dark" },
  { col: "done", tags: ["Website"], title: "Publish landing page draft" },
  { col: "done", tags: ["UX Design"], title: "Map core user journey" },
  { col: "done", tags: ["Planning"], title: "Kickoff meeting" },
].map((t, id) => ({ id, comments: 12, files: 4, ...t }));

const state = { status: "active", query: "", project: "CreativeSync Hub", view: "kanban" };
const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const chevron = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>';

function renderStatusTabs() {
  const labels = { active: "Active", hold: "On Hold", closed: "Closed" };
  $("#statusTabs").innerHTML = Object.entries(labels).map(([k, l]) => {
    const n = String(PROJECTS.filter((p) => p.status === k).length).padStart(2, "0");
    return `<button role="tab" data-status="${k}" class="${state.status === k ? "is-active" : ""}">${l}(${n})</button>`;
  }).join("");
}

function renderProjects() {
  const q = state.query.toLowerCase();
  $("#projectList").innerHTML = PROJECTS
    .filter((p) => p.status === state.status && p.name.toLowerCase().includes(q))
    .map((p) => `<li class="project ${p.name === state.project ? "is-active" : ""}" data-name="${esc(p.name)}">
      <span class="project__icon" style="background:${p.tint}">${p.icon}</span>
      <div><div class="project__name">${esc(p.name)}</div><div class="project__meta">${p.type}<b></b>${p.area}</div></div>${chevron}
    </li>`).join("") || `<li class="project__meta" style="padding:12px">No projects found</li>`;
}

function renderHeader() {
  const p = PROJECTS.find((x) => x.name === state.project);
  $("#projectName").textContent = p.name;
  $("#crumbs").textContent = `${p.type}/ ${p.area === "All" ? "UI Design" : p.area}/ Project`;
}

const tagHtml = (t) => { const [bg, fg] = TAGS[t] || ["#eee", "#333"]; return `<span class="tag" style="background:${bg};color:${fg}">${esc(t)}</span>`; };
const foot = (t) => `<div class="card__foot">
  <span><svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>${t.comments}</span>
  <span><svg viewBox="0 0 24 24"><path d="m20 11-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7"/></svg>${t.files}</span>
  <span class="card__assigned">Assigned to <span class="avatars"><span class="av av--1"></span><span class="av av--3"></span></span></span></div>`;

function cardHtml(t) {
  return `<article class="card" draggable="true" data-id="${t.id}">
    <div class="card__tags">${t.tags.map(tagHtml).join("")}<button class="card__more" aria-label="More"><svg viewBox="0 0 24 24" class="fill"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button></div>
    <h3 class="card__title">${esc(t.title)}</h3>
    ${t.thumb ? `<div class="card__thumb ${t.thumb}"><i></i><i></i></div>` : ""}${foot(t)}</article>`;
}

function renderBoard() {
  const board = $("#board");
  if (state.view === "kanban") {
    board.innerHTML = `<div class="kanban">${COLUMNS.map((c) => {
      const items = tasks.filter((t) => t.col === c.id);
      return `<div class="col"><div class="col__head"><span class="dot" style="background:${c.color}"></span>${c.label}
        <span class="count">${items.length}</span><button class="col__add" data-add="${c.id}" aria-label="Add task">+</button></div>
        <div class="col__cards" data-col="${c.id}">${items.map(cardHtml).join("")}</div></div>`;
    }).join("")}</div>`;
  } else if (state.view === "table") {
    const label = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));
    board.innerHTML = `<table class="table"><thead><tr><th>Task</th><th>Tags</th><th>Status</th><th>Comments</th><th>Files</th></tr></thead><tbody>
      ${tasks.map((t) => `<tr><td>${esc(t.title)}</td><td>${t.tags.map(tagHtml).join(" ")}</td><td>${label[t.col]}</td><td>${t.comments}</td><td>${t.files}</td></tr>`).join("")}</tbody></table>`;
  } else {
    board.innerHTML = `<div class="list">${tasks.map((t) => `<article class="card"><div class="card__tags">${t.tags.map(tagHtml).join("")}</div><h3 class="card__title">${esc(t.title)}</h3>${foot(t)}</article>`).join("")}</div>`;
  }
}

function addTask(col) {
  const title = prompt("Task title");
  if (!title) return;
  tasks.push({ id: tasks.length, col, tags: ["Planning"], title, comments: 0, files: 0 });
  renderBoard();
}

// Events
$("#statusTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.status = b.dataset.status; renderStatusTabs(); renderProjects();
});
$("#search").addEventListener("input", (e) => { state.query = e.target.value; renderProjects(); });
$("#projectList").addEventListener("click", (e) => {
  const li = e.target.closest(".project"); if (!li) return;
  state.project = li.dataset.name; renderProjects(); renderHeader();
});
$("#pageTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#pageTabs button").forEach((x) => x.classList.toggle("is-active", x === b));
});
$("#views").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.view = b.dataset.view;
  document.querySelectorAll("#views button").forEach((x) => x.classList.toggle("is-active", x === b));
  renderBoard();
});
$("#starBtn").addEventListener("click", (e) => {
  const b = e.currentTarget; b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
});
$("#newBoard").addEventListener("click", () => addTask("todo"));

const board = $("#board");
board.addEventListener("click", (e) => { const b = e.target.closest("[data-add]"); if (b) addTask(b.dataset.add); });
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
  e.preventDefault();
  const t = tasks.find((x) => x.id === Number(e.dataTransfer.getData("text/plain")));
  if (t) { t.col = col.dataset.col; renderBoard(); }
});

renderStatusTabs(); renderProjects(); renderHeader(); renderBoard();
