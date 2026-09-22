# Bin Duty

Household waste-sorting app for the house: what goes out tonight, whose turn it is,
a sorting quiz, a camera-based bin checker, and a Scrap-coin leaderboard for who
actually took the bins out.

Runs as a small Node/Express server (`server/`) serving a static frontend
(`public/`), backed by SQLite for the leaderboard and Google Gemini for the
camera check.

## Local development

```bash
cd server
npm install
cp ../.env.example ../.env   # then edit .env yourself and add your real GEMINI_API_KEY
npm start
```

Open http://localhost:3000. The app works fully without a Gemini key — only the
camera-check button will show a friendly "not available" message until one is set.

Get a Gemini API key at https://aistudio.google.com/apikey. **Put it directly into
your own `.env` file** (already gitignored) — never share it in chat, a commit, or
anywhere else it could leak. `.env` is loaded by `dotenv` and read only server-side;
it's never sent to the browser.

## Docker

```bash
cp .env.example .env   # add your real GEMINI_API_KEY
docker compose up -d --build
```

The SQLite database persists in `./server/data` (mounted as a volume), so the
leaderboard survives container restarts/rebuilds.

## Deploying to your own server

1. Get the code onto the server (`git clone`, or `rsync` this directory).
2. Install Docker + Docker Compose on the server, or Node 18+ if running it directly.
3. Create `.env` **on the server itself** with the real `GEMINI_API_KEY` — don't
   put a production key in git history.
4. `docker compose up -d --build` (or `cd server && npm install && npm start`
   under a process manager like `pm2` or a `systemd` unit if not using Docker).
5. Put a reverse proxy in front for HTTPS and a domain — Caddy is the simplest
   (`your-domain.com { reverse_proxy localhost:3000 }`, automatic Let's Encrypt),
   or nginx + certbot if that's what you already run.
6. Point the house's Bin Duty link at your domain instead of the Claude artifact
   version.

## Project layout

```
server/
  index.js     Express app: /api/check (Gemini), /api/claims (SQLite leaderboard)
  gemini.js    Gemini vision call for the camera bin-checker
  db.js        SQLite setup
public/
  index.html   Page structure
  i18n.js      Language switcher data (10 languages; 5 fully translated so far —
               zh/hi/bn/ar/ur currently fall back to English, RTL layout works
               for ar/ur already)
  app.js       All client logic: game, calendar, duty rotation, rewards, camera check
```

## What's intentionally not automated here

- **Email reminders**: not wired up, because it would need a mail-sending
  credential (SMTP password or app password) held somewhere. Don't put one in
  this repo or its `.env` either, for the same reason `GEMINI_API_KEY` gets a
  warning above — a checked-in or shared credential is a real exposure risk.
  A Google Apps Script that sends under your own Google sign-in (no password
  needed) is the safer route; ask for it again if you want it regenerated.
