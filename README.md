# BUN-FIGHT 🥯🥐🫓

Real-time, browser-based "king of the hill" tournament game. Players join a
queue, challenge the reigning champion in best-of-3 rounds of
BUN / CROISSANT / TORTILLA (a 3-way rock-paper-scissors), and climb an ESP
leaderboard. One page serves both the player view (`/`) and a spectator/host
dashboard (`/host`).

This is the **consolidated backend** — a single Node/Express + Socket.IO
server. (There used to be a parallel Flask implementation; it's been
retired in favor of this one, since Node deploys with the least friction on
free hosting — see "Deploying" below.)

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:5000` (player view) and
`http://localhost:5000/host` (host/spectator view) in separate tabs.

Optional environment variables (see `.env.example`):

- `PORT` — defaults to `5000`.
- `CORS_ORIGIN` — defaults to `*`. Set this to your deployed frontend origin
  in production.

## Deploying for free

Both WebSocket support and free-tier eligibility on platforms like Render
are handled at the platform level, not the language level — but Node
deploys with noticeably less setup than the old Flask/Flask-SocketIO
version did (no async worker class to configure, no Gunicorn command to get
right). Render auto-detects this repo as a Node app.

1. Push this project to a GitHub repo.
2. On [Render](https://render.com), create a new **Web Service** from that
   repo. No Dockerfile needed — Render detects `package.json` and runs
   `npm install` / `npm start` automatically.
3. (Optional) Set the `CORS_ORIGIN` environment variable to your Render URL
   once you know it.
4. Deploy. You'll get a URL like `https://bun-fight.onrender.com`.

**Free-tier trade-off to know about:** Render's free web services spin down
after 15 minutes of no inbound traffic (HTTP or WebSocket) and take about a
minute to wake back up on the next connection. Fine for a party game you
spin up on demand; not something you'd want for an always-on production
service.

## What's implemented

- Matchmaking queue, champion/challenger rotation, best-of-3 rounds, tie
  (re-throw) handling.
- Live leaderboard (ESP rating) and win/loss streak tracking.
- Reconnect-by-nickname (closing and reopening the tab picks your identity
  back up, as long as your old connection has actually dropped).
- **Duplicate-name protection**: joining with a nickname that's already
  claimed by another currently-connected player is rejected with an
  inline error, instead of silently colliding two players into one
  identity.
- Host dashboard: queue, leaderboard, live match monitor, round history,
  "always picks the same move" pattern warnings.
- Auto-advance to the next round ~3.5s after a result, with safe timer
  cleanup on reset/disconnect so rounds never double-advance.

## Known limitations (by design, for now)

- **In-memory state only.** All game state (queue, leaderboard, match)
  lives in the Node process's memory. A restart or redeploy clears it.
  Given the free-hosting target (ephemeral filesystem, periodic spin-down),
  persisting to disk wouldn't survive anyway — a real fix would mean an
  external store (e.g. Redis/Postgres on a free-tier add-on), which is a
  reasonable next step if you outgrow "in-memory is fine."
- **Single process.** No horizontal scaling — fine for the free tier's
  single instance, but note if you ever move to a paid multi-instance plan
  you'd need a Socket.IO adapter (e.g. `@socket.io/redis-adapter`) to keep
  state consistent across instances.
- **Name-based identity**, not account-based. Reconnecting relies on your
  old socket having actually disconnected; a very fast refresh can in rare
  cases briefly report "name taken" until the old connection times out.
