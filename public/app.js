/* Sprintboard — kanban state, drag & drop, and AI day planning */

const STORAGE_KEY = "sprintboard.tasks.v1";
const COLUMNS = ["backlog", "today", "inprogress", "done"];

let tasks = load();
let editingId = null;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : seedTasks();
  } catch {
    return seedTasks();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function seedTasks() {
  return [
    {
      id: crypto.randomUUID(),
      title: "Try Sprintboard: drag me to Today",
      description: "Cards drag between columns. Points estimate effort.",
      points: 1,
      priority: "medium",
      due: null,
      column: "backlog",
    },
  ];
}

/* ---------- rendering ---------- */

function render() {
  for (const col of COLUMNS) {
    const container = document.querySelector(`[data-drop="${col}"]`);
    container.innerHTML = "";
    const colTasks = tasks.filter((t) => t.column === col);
    document.querySelector(`[data-column="${col}"] .count`).textContent =
      colTasks.length ? `${colTasks.length} · ${sum(colTasks)} pts` : "";

    if (colTasks.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = col === "backlog" ? "Add tasks with “+ New task”" : "Drop tasks here";
      container.appendChild(hint);
      continue;
    }
    for (const t of colTasks) container.appendChild(renderCard(t));
  }
  renderStats();
}

function renderCard(t) {
  const card = document.createElement("article");
  card.className = "card";
  card.draggable = true;
  card.dataset.id = t.id;

  const h = document.createElement("h3");
  h.textContent = t.title;
  card.appendChild(h);

  if (t.description) {
    const p = document.createElement("p");
    p.className = "desc";
    p.textContent = t.description;
    card.appendChild(p);
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";

  meta.appendChild(chip(`${t.points} pt${t.points > 1 ? "s" : ""}`, "chip-points"));
  meta.appendChild(chip(t.priority, `chip-${t.priority}`));
  if (t.due) {
    const overdue = t.due < new Date().toISOString().slice(0, 10) && t.column !== "done";
    meta.appendChild(chip(`due ${t.due.slice(5)}`, `chip-due${overdue ? " overdue" : ""}`));
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const edit = document.createElement("button");
  edit.textContent = "✎";
  edit.title = "Edit";
  edit.addEventListener("click", () => openDialog(t.id));
  const del = document.createElement("button");
  del.textContent = "✕";
  del.title = "Delete";
  del.addEventListener("click", () => {
    tasks = tasks.filter((x) => x.id !== t.id);
    save();
    render();
  });
  actions.append(edit, del);
  meta.appendChild(actions);
  card.appendChild(meta);

  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", t.id);
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));

  return card;
}

function chip(text, cls) {
  const s = document.createElement("span");
  s.className = `chip ${cls}`;
  s.textContent = text;
  return s;
}

function sum(list) {
  return list.reduce((a, t) => a + Number(t.points || 0), 0);
}

function renderStats() {
  const committed = sum(tasks.filter((t) => t.column !== "backlog"));
  const done = sum(tasks.filter((t) => t.column === "done"));
  document.getElementById("stat-committed").textContent = committed;
  document.getElementById("stat-done").textContent = done;
  document.getElementById("stat-progress").textContent = committed
    ? `${Math.round((done / committed) * 100)}%`
    : "0%";
}

/* ---------- drag & drop ---------- */

for (const zone of document.querySelectorAll("[data-drop]")) {
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const id = e.dataTransfer.getData("text/plain");
    const task = tasks.find((t) => t.id === id);
    if (task) {
      task.column = zone.dataset.drop;
      save();
      render();
    }
  });
}

/* ---------- task dialog ---------- */

const dialog = document.getElementById("task-dialog");
const form = document.getElementById("task-form");

function openDialog(id = null) {
  editingId = id;
  const t = id ? tasks.find((x) => x.id === id) : null;
  document.getElementById("dialog-title").textContent = t ? "Edit task" : "New task";
  document.getElementById("task-title").value = t?.title || "";
  document.getElementById("task-desc").value = t?.description || "";
  document.getElementById("task-points").value = t?.points || 2;
  document.getElementById("task-priority").value = t?.priority || "medium";
  document.getElementById("task-due").value = t?.due || "";
  dialog.showModal();
}

document.getElementById("btn-add-task").addEventListener("click", () => openDialog());
document.getElementById("btn-cancel").addEventListener("click", () => dialog.close());

form.addEventListener("submit", () => {
  const data = {
    title: document.getElementById("task-title").value.trim(),
    description: document.getElementById("task-desc").value.trim(),
    points: Number(document.getElementById("task-points").value),
    priority: document.getElementById("task-priority").value,
    due: document.getElementById("task-due").value || null,
  };
  if (!data.title) return;
  if (editingId) {
    Object.assign(tasks.find((t) => t.id === editingId), data);
  } else {
    tasks.push({ id: crypto.randomUUID(), column: "backlog", ...data });
  }
  save();
  render();
});

/* ---------- AI day planning ---------- */

const planBtn = document.getElementById("btn-plan");
const planOutput = document.getElementById("plan-output");

planBtn.addEventListener("click", async () => {
  // Plan Today + In Progress, plus urgent backlog items (due within 2 days or high priority)
  const soon = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10);
  const plannable = tasks.filter(
    (t) =>
      t.column === "today" ||
      t.column === "inprogress" ||
      (t.column === "backlog" && ((t.due && t.due <= soon) || t.priority === "high"))
  );

  if (plannable.length === 0) {
    planOutput.innerHTML =
      '<div class="plan-error">Nothing to plan — move some tasks into Today or In Progress first.</div>';
    return;
  }

  planBtn.disabled = true;
  planOutput.innerHTML =
    '<div class="plan-loading">Claude is planning your day… (this can take up to a minute)</div>';

  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: plannable,
        dayStart: document.getElementById("plan-start").value,
        dayEnd: document.getElementById("plan-end").value,
        notes: document.getElementById("plan-notes").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    renderPlan(data);
  } catch (err) {
    planOutput.innerHTML = `<div class="plan-error">${escapeHtml(err.message)}</div>`;
  } finally {
    planBtn.disabled = false;
  }
});

function renderPlan(plan) {
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  let html = `<div class="plan-summary">${escapeHtml(plan.summary)}</div><div class="timeline">`;

  for (const b of plan.schedule) {
    const taskTitle = b.task_id && byId[b.task_id] ? byId[b.task_id].title : null;
    html += `
      <div class="block kind-${escapeHtml(b.kind)}">
        <time>${escapeHtml(b.start)}–${escapeHtml(b.end)}</time>
        <div>
          <div class="block-label">${escapeHtml(taskTitle || b.label)}</div>
          <div class="block-note">${escapeHtml(b.note)}</div>
        </div>
      </div>`;
  }
  html += "</div>";

  if (plan.warnings?.length) {
    html += `<div class="plan-warnings"><ul>${plan.warnings
      .map((w) => `<li>⚠ ${escapeHtml(w)}</li>`)
      .join("")}</ul></div>`;
  }

  if (plan.deferred_task_ids?.length) {
    const names = plan.deferred_task_ids
      .map((id) => byId[id]?.title)
      .filter(Boolean)
      .map(escapeHtml)
      .join(", ");
    if (names) html += `<div class="plan-deferred">Deferred for another day: ${names}</div>`;
  }

  planOutput.innerHTML = html;
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

render();
