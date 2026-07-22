require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3111;

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
- Story points indicate relative effort (1 ≈ under 30 min, 2 ≈ about an hour, 3 ≈ a couple of hours, 5 ≈ half a day, 8 ≈ a full day or needs splitting).
- Schedule the hardest or highest-priority work early in the window unless the user's energy note says otherwise.
- Tasks already "in progress" usually come first - finishing beats starting.
- Respect due dates: anything due today or overdue must be scheduled or explicitly flagged in warnings.
- Insert short breaks between focus blocks and leave 10-15% of the window as buffer.
- Batch small 1-point tasks into a single shallow-work block instead of scattering them.
- Never invent tasks. Only reference task ids that exist on the board.`;

app.post("/api/plan", async (req, res) => {
  const { tasks, dayStart, dayEnd, notes } = req.body || {};

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res
      .status(400)
      .json({ error: "No plannable tasks. Add tasks to Today or In Progress first." });
  }

  const userPayload = {
    today: new Date().toISOString().slice(0, 10),
    working_window: { start: dayStart || "09:00", end: dayEnd || "17:00" },
    user_notes: notes || "(none)",
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description || "",
      points: t.points,
      priority: t.priority,
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
