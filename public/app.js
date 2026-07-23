/* MyDay — kanban state, drag & drop, and AI day planning */

const STORAGE_KEY = "myday.tasks.v1";
const LEGACY_STORAGE_KEY = "sprintboard.tasks.v1"; // pre-rename backup key
const NOTES_KEY = "myday.notes"; // offline backup of the persistent notes field
const COLUMNS = ["backlog", "today", "inprogress", "done"];

let tasks = [];
let editingId = null;

// Tasks live on the server (data/tasks.json). localStorage is kept as an
// offline backup and as the migration source for pre-server boards.
async function init() {
  try {
    const res = await fetch("/api/tasks");
    if (!res.ok) throw new Error(`GET /api/tasks ${res.status}`);
    let serverTasks = migrate((await res.json()).tasks || []);
    if (serverTasks.length === 0) {
      const local = readLocalBackup();
      if (local.length) {
        serverTasks = local; // one-time migration of the old browser-only board
        await pushTasks(serverTasks);
      }
    }
    tasks = serverTasks.length ? serverTasks : seedTasks();
  } catch {
    tasks = readLocalBackup(); // offline fallback
    setSyncStatus(false);
  }
  writeLocalBackup(tasks);
  render();
  await loadSettings();
}

// The notes field persists across days (data/settings.json), unlike the
// working-window times which reset to their defaults each session.
async function loadSettings() {
  const notesEl = document.getElementById("plan-notes");
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error(`GET /api/settings ${res.status}`);
    const { notes } = await res.json();
    notesEl.value = notes || "";
    localStorage.setItem(NOTES_KEY, notesEl.value);
  } catch {
    notesEl.value = localStorage.getItem(NOTES_KEY) || ""; // offline fallback
  }
  // Save as the user types (debounced) and immediately on blur.
  let timer;
  notesEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(saveNotes, 700);
  });
  notesEl.addEventListener("blur", () => {
    clearTimeout(timer);
    saveNotes();
  });
}

async function saveNotes() {
  const notes = document.getElementById("plan-notes").value;
  localStorage.setItem(NOTES_KEY, notes);
  try {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
  } catch {
    /* kept in localStorage; will re-sync on the next successful save */
  }
}

function readLocalBackup() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? migrate(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeLocalBackup(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

async function pushTasks(list) {
  const res = await fetch("/api/tasks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks: list }),
  });
  if (!res.ok) throw new Error(`PUT /api/tasks ${res.status}`);
}

function setSyncStatus(ok) {
  const el = document.getElementById("sync-status");
  el.textContent = ok ? "" : "⚠ not synced — changes saved only in this browser";
}

// Older tasks used story points + priority; convert points to a time estimate.
function migrate(list) {
  const pointsToMin = { 1: 30, 2: 60, 3: 120, 5: 240, 8: 480 };
  for (const t of list) {
    if (t.estimateMin == null) t.estimateMin = pointsToMin[t.points] || 60;
    delete t.points;
    delete t.priority;
  }
  return list;
}

function save() {
  writeLocalBackup(tasks);
  pushTasks(tasks)
    .then(() => setSyncStatus(true))
    .catch(() => setSyncStatus(false));
}

function seedTasks() {
  return [
    {
      id: crypto.randomUUID(),
      title: "Try MyDay: drag me to Today",
      description: "Cards drag between columns. Estimates drive the day plan.",
      estimateMin: 30,
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
      colTasks.length ? `${colTasks.length} · ${formatMin(sumMin(colTasks))}` : "";

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

  meta.appendChild(chip(formatMin(t.estimateMin), "chip-time"));
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

function sumMin(list) {
  return list.reduce((a, t) => a + Number(t.estimateMin || 0), 0);
}

function formatMin(min) {
  min = Number(min) || 0;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function renderStats() {
  const committed = sumMin(tasks.filter((t) => t.column !== "backlog"));
  const done = sumMin(tasks.filter((t) => t.column === "done"));
  document.getElementById("stat-committed").textContent = formatMin(committed);
  document.getElementById("stat-done").textContent = formatMin(done);
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
  const est = document.getElementById("task-estimate");
  est.value = [...est.options].some((o) => o.value == t?.estimateMin)
    ? String(t.estimateMin)
    : "60";
  document.getElementById("task-due").value = t?.due || "";
  dialog.showModal();
}

document.getElementById("btn-add-task").addEventListener("click", () => openDialog());
document.getElementById("btn-cancel").addEventListener("click", () => dialog.close());

form.addEventListener("submit", () => {
  const data = {
    title: document.getElementById("task-title").value.trim(),
    description: document.getElementById("task-desc").value.trim(),
    estimateMin: Number(document.getElementById("task-estimate").value),
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

/* ---------- planner chat ---------- */

const chatThread = document.getElementById("chat-thread");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("btn-send");
const chatHistory = []; // {role, content} — session-only

function addBubble(role, html, { asText = true } = {}) {
  const div = document.createElement("div");
  div.className = `bubble bubble-${role}`;
  if (asText) div.textContent = html;
  else div.innerHTML = html;
  chatThread.appendChild(div);
  chatThread.scrollTop = chatThread.scrollHeight;
  return div;
}

function currentSettings() {
  return {
    dayStart: document.getElementById("plan-start").value,
    dayEnd: document.getElementById("plan-end").value,
    notes: document.getElementById("plan-notes").value,
  };
}

function applySettingsPatch(patch) {
  const fields = {
    dayStart: "plan-start",
    dayEnd: "plan-end",
    notes: "plan-notes",
  };
  for (const [key, id] of Object.entries(fields)) {
    if (patch[key] == null) continue;
    const el = document.getElementById(id);
    el.value = patch[key];
    el.classList.remove("field-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("field-flash");
  }
  if (patch.notes != null) saveNotes(); // persist agent edits to notes
}

async function refreshTasks() {
  try {
    const res = await fetch("/api/tasks");
    if (!res.ok) return;
    tasks = migrate((await res.json()).tasks || []);
    writeLocalBackup(tasks);
    render();
  } catch {
    /* board keeps current state */
  }
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || sendBtn.disabled) return;
  chatInput.value = "";
  sendBtn.disabled = true;

  chatHistory.push({ role: "user", content: text });
  addBubble("user", text);
  const pending = addBubble("assistant", "…");
  pending.classList.add("bubble-pending");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory, settings: currentSettings() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    pending.classList.remove("bubble-pending");
    pending.textContent = data.reply || "Done.";
    chatHistory.push({ role: "assistant", content: data.reply || "Done." });

    if (data.settingsPatch && Object.keys(data.settingsPatch).length) {
      applySettingsPatch(data.settingsPatch);
    }
    if (data.tasksChanged) await refreshTasks();
  } catch (err) {
    pending.classList.remove("bubble-pending");
    pending.classList.add("bubble-error");
    pending.textContent = err.message;
    chatHistory.pop(); // let the user retry the same message
  } finally {
    sendBtn.disabled = false;
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }
});

/* ---------- AI day planning ---------- */

const planBtn = document.getElementById("btn-plan");
const planPanel = document.getElementById("plan-panel");

function showPlanPanel(html) {
  planPanel.innerHTML = html;
  planPanel.hidden = false;
  planPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

planBtn.addEventListener("click", async () => {
  // Plan Today + In Progress, plus backlog items due within 2 days
  const soon = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10);
  const plannable = tasks.filter(
    (t) =>
      t.column === "today" ||
      t.column === "inprogress" ||
      (t.column === "backlog" && t.due && t.due <= soon)
  );

  if (plannable.length === 0) {
    showPlanPanel(
      '<div class="plan-panel-error">Nothing to plan — move some tasks into Today or In Progress first.</div>'
    );
    return;
  }

  planBtn.disabled = true;
  showPlanPanel('<div class="plan-panel-loading">Planning your day… (this can take up to a minute)</div>');

  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: plannable, ...currentSettings() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    renderPlan(data);
    // Let the chat agent know a plan exists so follow-up conversation has context.
    chatHistory.push({
      role: "assistant",
      content: `[I generated a day plan] ${data.summary}`,
    });
  } catch (err) {
    showPlanPanel(`<div class="plan-panel-error">${escapeHtml(err.message)}</div>`);
  } finally {
    planBtn.disabled = false;
  }
});

function renderPlan(plan) {
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  let html = `<div class="plan-panel-head"><h2>Today's schedule</h2></div>`;
  html += `<div class="plan-summary">${escapeHtml(plan.summary)}</div><div class="timeline">`;

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

  showPlanPanel(html);
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

init();
