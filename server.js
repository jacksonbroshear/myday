require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3111;

// Where tasks are persisted. Locally this is a gitignored ./data/tasks.json;
// on a deploy, point DATA_FILE at a persistent volume (see render.yaml).
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "tasks.json");

// Optional shared-password gate for public deployments: set APP_PASSWORD and
// the whole site (UI + API) requires it via HTTP Basic auth. Off when unset.
app.use((req, res, next) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return next();
  const header = req.headers.authorization || "";
  const decoded = Buffer.from(header.replace(/^Basic\s+/i, ""), "base64").toString();
  if (decoded.slice(decoded.indexOf(":") + 1) === pw) return next();
  res.set("WWW-Authenticate", 'Basic realm="MyDay"');
  res.status(401).send("Password required");
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Resolves credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
// or an `ant auth login` profile.
const client = new Anthropic();

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "Two or three sentences addressed to the user: the shape of their day and the key tradeoff you made.",
    },
    schedule: {
      type: "array",
      description:
        "Time-ordered blocks covering the working window, including breaks and buffer.",
      items: {
        type: "object",
        properties: {
          start: { type: "string", description: "24h HH:MM" },
          end: { type: "string", description: "24h HH:MM" },
          task_id: {
            type: ["string", "null"],
            description:
              "The id of the task this block works on, or null for breaks/buffer/rituals.",
          },
          label: { type: "string", description: "Short label for the block." },
          kind: {
            type: "string",
            enum: ["focus", "shallow", "break", "buffer", "ritual"],
          },
          note: {
            type: "string",
            description:
              "One sentence of coaching: how to approach this block, or why it is placed here.",
          },
        },
        required: ["start", "end", "task_id", "label", "kind", "note"],
        additionalProperties: false,
      },
    },
    deferred_task_ids: {
      type: "array",
      description:
        "Ids of tasks that were considered but do not fit today and should stay in the backlog.",
      items: { type: "string" },
    },
    warnings: {
      type: "array",
      description:
        "Honest flags: overcommitment, missing estimates, deadline risk. Empty if none.",
      items: { type: "string" },
    },
  },
  required: ["summary", "schedule", "deferred_task_ids", "warnings"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the planning assistant inside a personal scrum task tracker. The user gives you their task board and their constraints for today; you produce a realistic, time-blocked plan for the day.

Planning principles:
- Be realistic, not aspirational. A day holds roughly 3-4 hours of deep focus. If the board is overcommitted, say so in warnings and defer tasks rather than cramming.
- Each task carries the user's estimated duration in minutes (estimate_min). Treat estimates as optimistic: schedule roughly the estimated time but leave slack, and split anything estimated over ~2 hours into multiple blocks.
- Schedule the largest or most demanding work early in the window unless the user's energy note says otherwise.
- Tasks already "in progress" usually come first - finishing beats starting.
- Respect due dates: anything due today or overdue must be scheduled or explicitly flagged in warnings.
- Insert short breaks between focus blocks and leave 10-15% of the window as buffer.
- Batch small tasks (30 minutes or less) into a single shallow-work block instead of scattering them.
- Never invent tasks. Only reference task ids that exist on the board.`;

async function readTasks() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeTasks(tasks) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(tasks, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

app.get("/api/tasks", async (req, res) => {
  try {
    res.json({ tasks: await readTasks() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not read tasks." });
  }
});

app.put("/api/tasks", async (req, res) => {
  const { tasks } = req.body || {};
  if (!Array.isArray(tasks)) {
    return res.status(400).json({ error: "Body must be { tasks: [...] }." });
  }
  try {
    await writeTasks(tasks);
    res.json({ ok: true, count: tasks.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save tasks." });
  }
});

const CHAT_TOOLS = [
  {
    name: "create_task",
    description:
      "Add a new task to the user's board. Use when the user mentions new work to track. The task appears on the board immediately. Do NOT use this for fixed appointments (meetings, lunches, calls) — those go in the notes field via update_planner_settings, unless there is real prep work to do.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title." },
        description: { type: "string", description: "Optional detail." },
        estimate_min: {
          type: "number",
          description: "Estimated minutes of work (15, 30, 60, 120, 240, or 480).",
        },
        due: {
          type: ["string", "null"],
          description: "Due date YYYY-MM-DD, or null if none.",
        },
        column: {
          type: "string",
          enum: ["backlog", "today", "inprogress"],
          description: "\"today\" for work the user intends to do today, otherwise \"backlog\".",
        },
      },
      required: ["title", "estimate_min"],
    },
  },
  {
    name: "update_planner_settings",
    description:
      "Update the planner controls shown in the sidebar: the working window (start/end times) and/or the free-form notes field. Notes hold fixed appointments and constraints (e.g. \"Lunch with Jennie 12:00-13:00\"). The notes value you send REPLACES the field, so merge new constraints with the current notes provided in context — never drop existing ones the user hasn't cancelled.",
    input_schema: {
      type: "object",
      properties: {
        day_start: { type: "string", description: "Working window start, 24h HH:MM." },
        day_end: { type: "string", description: "Working window end, 24h HH:MM." },
        notes: { type: "string", description: "Full replacement text for the notes field." },
      },
    },
  },
];

const CHAT_SYSTEM = `You are the planning assistant inside MyDay, a personal task tracker. You chat with the user in a sidebar next to their kanban board (Backlog / Today / In Progress / Done). The current date, board, and planner settings are provided with each message.

You can act, not just talk:
- create_task adds a work item to the board.
- update_planner_settings changes the working window (start/end) and the notes field. Both are visible form fields the user sees update live.

Guidelines:
- Fixed appointments (meetings, lunches, calls) belong in notes with their times, not as tasks — they occupy time but aren't work items. Create a task as well only if there's real prep work.
- If an appointment runs past the current working window, extend day_end (or day_start) to fit it when the user asks.
- When the user mentions new work, create a task with a realistic estimate; column "today" if it's for today, otherwise "backlog" with a due date if one is implied.
- Estimates: 15/30/60/120/240/480 minutes are the standard sizes.
- After making changes, confirm what you did in one or two friendly sentences, and if it affects today's schedule, suggest pressing "✦ Plan my day" to rebuild the plan.
- If the user just wants to talk through their day, be a concise, honest sounding board. Don't invent tasks they didn't mention.`;

const VALID_COLUMNS = ["backlog", "today", "inprogress"];

app.post("/api/chat", async (req, res) => {
  const { messages, settings } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "No messages." });
  }

  const settingsPatch = {};
  let tasksChanged = false;

  try {
    const board = await readTasks();
    const context = {
      today: new Date().toISOString().slice(0, 10),
      planner_settings: {
        day_start: settings?.dayStart || "07:00",
        day_end: settings?.dayEnd || "13:00",
        notes: settings?.notes || "(empty)",
      },
      board: board.map((t) => ({
        id: t.id,
        title: t.title,
        estimate_min: t.estimateMin,
        due: t.due,
        column: t.column,
      })),
    };

    const convo = [
      {
        role: "user",
        content: `Current state:\n${JSON.stringify(context, null, 2)}`,
      },
      { role: "assistant", content: "Understood — I have the current board and settings." },
      ...messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content),
      })),
    ];

    for (let turn = 0; turn < 5; turn++) {
      const response = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: CHAT_SYSTEM,
        tools: CHAT_TOOLS,
        messages: convo,
      });

      if (response.stop_reason !== "tool_use") {
        const reply = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return res.json({ reply, settingsPatch, tasksChanged });
      }

      convo.push({ role: "assistant", content: response.content });
      const results = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "create_task") {
          const input = block.input || {};
          const task = {
            id: crypto.randomUUID(),
            title: String(input.title || "Untitled task").slice(0, 120),
            description: String(input.description || "").slice(0, 500),
            estimateMin: Number(input.estimate_min) || 60,
            due: typeof input.due === "string" ? input.due : null,
            column: VALID_COLUMNS.includes(input.column) ? input.column : "today",
          };
          const list = await readTasks();
          list.push(task);
          await writeTasks(list);
          tasksChanged = true;
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Created task "${task.title}" (${task.estimateMin} min) in ${task.column}.`,
          });
        } else if (block.name === "update_planner_settings") {
          const input = block.input || {};
          if (input.day_start) settingsPatch.dayStart = String(input.day_start);
          if (input.day_end) settingsPatch.dayEnd = String(input.day_end);
          if (typeof input.notes === "string") settingsPatch.notes = input.notes;
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Planner settings updated in the sidebar.",
          });
        } else {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Unknown tool ${block.name}.`,
            is_error: true,
          });
        }
      }
      convo.push({ role: "user", content: results });
    }

    res.json({
      reply: "I made the changes but ran out of turns to summarize — check the board and settings.",
      settingsPatch,
      tasksChanged,
    });
  } catch (err) {
    if (
      err instanceof Anthropic.AuthenticationError ||
      /authentication method|apiKey/i.test(err?.message || "")
    ) {
      return res.status(401).json({
        error: "No valid Anthropic credentials. Set ANTHROPIC_API_KEY and restart the server.",
      });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Rate limited — try again in a minute." });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Claude API error: ${err.message}` });
    }
    console.error(err);
    res.status(500).json({ error: "Chat failed unexpectedly." });
  }
});

app.post("/api/plan", async (req, res) => {
  const { tasks, dayStart, dayEnd, notes } = req.body || {};

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res
      .status(400)
      .json({ error: "No plannable tasks. Add tasks to Today or In Progress first." });
  }

  const userPayload = {
    today: new Date().toISOString().slice(0, 10),
    working_window: { start: dayStart || "07:00", end: dayEnd || "13:00" },
    user_notes: notes || "(none)",
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description || "",
      estimate_min: Number(t.estimateMin) || 60,
      due: t.due || null,
      column: t.column,
    })),
  };

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Plan my day. Here is my board and my constraints as JSON:\n\n${JSON.stringify(userPayload, null, 2)}`,
        },
      ],
      output_config: {
        format: { type: "json_schema", schema: PLAN_SCHEMA },
      },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      return res.status(502).json({ error: "Model returned no plan." });
    }
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    if (
      err instanceof Anthropic.AuthenticationError ||
      /authentication method|apiKey/i.test(err?.message || "")
    ) {
      return res.status(401).json({
        error:
          "No valid Anthropic credentials. Set ANTHROPIC_API_KEY or run `ant auth login`, then restart the server.",
      });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Rate limited — try again in a minute." });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Claude API error: ${err.message}` });
    }
    console.error(err);
    res.status(500).json({ error: "Planning failed unexpectedly." });
  }
});

app.listen(PORT, () => {
  console.log(`Scrum planner running at http://localhost:${PORT}`);
});
