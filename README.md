# Sprintboard

A personal scrum task tracker with AI-assisted day planning. Kanban board
(Backlog → Today → In Progress → Done) with time estimates and due dates;
Claude turns your committed tasks into a realistic, time-blocked plan for
the day.

## Run it

```sh
cd scrum-planner
npm install
cp .env.example .env                   # then paste your Anthropic API key into .env
npm start                              # http://localhost:3111
```

The server reads `ANTHROPIC_API_KEY` from `.env` (gitignored) or the
environment — the key is required only for the "Plan my day" feature.

Tasks are stored server-side in `data/tasks.json` (gitignored). The browser
keeps a localStorage backup and falls back to it if the server is
unreachable; a pre-server board is migrated up automatically on first load.

## Deploying

The app is deploy-ready for any Node host:

- `PORT` — listening port (default 3111)
- `DATA_FILE` — where tasks persist; point it at a persistent volume
- `ANTHROPIC_API_KEY` — server-side secret for the planner
- `APP_PASSWORD` — **set this on any public deploy.** It gates the whole
  site behind a password (HTTP Basic auth), so strangers can't read your
  tasks or spend your API credits.

A ready-made `render.yaml` is included: connect the repo on Render, paste
the two secrets in the dashboard, and it deploys with a persistent disk.

The board itself works with no API key — tasks persist in your browser's
localStorage. The key is only needed for the AI planner.

## How planning works

Clicking **✦ Plan my day** sends your Today + In Progress tasks (plus any
backlog items due within 2 days), your working window, and free-form notes
to `POST /api/plan`. The server asks Claude (Opus 4.8, adaptive thinking,
structured JSON output) for a time-blocked schedule with breaks and buffer,
honest warnings about overcommitment, and a list of tasks to defer.

Each task carries an estimated duration (15 min – full day); the planner
treats estimates as optimistic, splits anything over ~2 hours into multiple
blocks, and batches sub-30-minute tasks into one shallow-work block.

## Files

- `server.js` — Express server + `/api/plan` Claude endpoint
- `public/` — vanilla JS frontend (no build step)
