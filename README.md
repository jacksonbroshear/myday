# Sprintboard

A personal scrum task tracker with AI-assisted day planning. Kanban board
(Backlog → Today → In Progress → Done) with story points, priorities, and due
dates; Claude turns your committed tasks into a realistic, time-blocked plan
for the day.

## Run it

```sh
cd scrum-planner
npm install
cp .env.example .env                   # then paste your Anthropic API key into .env
npm start                              # http://localhost:3111
```

The server reads `ANTHROPIC_API_KEY` from `.env` (gitignored) or the
environment — the key is required only for the "Plan my day" feature.

The board itself works with no API key — tasks persist in your browser's
localStorage. The key is only needed for the AI planner.

## How planning works

Clicking **✦ Plan my day** sends your Today + In Progress tasks (plus any
high-priority or soon-due backlog items), your working window, and free-form
notes to `POST /api/plan`. The server asks Claude (Opus 4.8, adaptive
thinking, structured JSON output) for a time-blocked schedule with breaks and
buffer, honest warnings about overcommitment, and a list of tasks to defer.

Story-point convention the planner uses: 1 ≈ under 30 min, 2 ≈ an hour,
3 ≈ a couple of hours, 5 ≈ half a day, 8 ≈ needs splitting.

## Files

- `server.js` — Express server + `/api/plan` Claude endpoint
- `public/` — vanilla JS frontend (no build step)
