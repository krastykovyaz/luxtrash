# Bin Duty

Household waste-sorting app for the house: what goes out tonight, whose turn it is,
a sorting quiz, a camera-based bin checker, a Scrap-coin leaderboard for who
actually took the bins out, and weekly email reminders in each person's own
language.

Runs as a small Node/Express server (`server/`) serving a static frontend
(`public/`), backed by SQLite for the leaderboard/roster/subscriptions, Google
Gemini for the camera check, and SMTP for email.

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

## Notifications (registration + weekly email)

Anyone on the roster can subscribe on the page itself — pick their name, enter an
email, pick a language — and a cron job (`node-cron`, Monday 07:00 server time by
default, `NOTIFY_CRON` in `.env` to change it) emails everyone subscribed their own
week's schedule, in their own language. There's no password/login: it's a mailing
list, not an account system, which matches a ~6-person house better than building
real auth.

**Email needs SMTP credentials**, same rule as the Gemini key: fill in
`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` in your own `.env`
yourself, never in chat. Any SMTP provider works:
- A transactional-email service (Postmark, Resend, Mailgun, Amazon SES) is the
  most reliable for more than a couple of recipients and gives you an API-key-style
  credential rather than a personal password.
- Gmail SMTP + an [app password](https://myaccount.google.com/apppasswords) works
  for a small house list, but Gmail throttles/flags anything that looks like bulk
  mail past a handful of recipients.

Leave the SMTP vars empty and everything else still works — registering just
won't actually send mail (the server logs a warning once and no-ops).

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
  index.js     Express app: /api/check (Gemini), /api/claims, /api/roster,
               /api/subscribe, plus the weekly cron trigger
  gemini.js    Gemini vision call for the camera bin-checker
  mailer.js    Builds and sends the weekly reminder email (SMTP via nodemailer)
  rotation.js  Collection schedule + duty-rotation math, shared by claims and mail
  i18n.js      Loads public/i18n.js server-side so email wording matches the app
  db.js        SQLite setup (claims, roster, accounts tables)
public/
  index.html   Page structure
  i18n.js      Language data — all 12 languages (English, Spanish, French,
               Portuguese, Russian, Chinese, Hindi, Bengali, Arabic, Urdu,
               Luxembourgish, Japanese) fully translated; browser UI defaults to
               English and remembers a per-device choice via localStorage,
               independent of each account's own notification-email language
  app.js       All client logic: game, calendar, duty rotation, roster
               management, rewards, camera check, notification sign-up
```
