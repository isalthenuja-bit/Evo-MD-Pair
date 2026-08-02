# Evo MD — WhatsApp Pair Code Generator

A lightweight Node.js/Express server that generates WhatsApp session credentials (pairing codes & QR codes) for the **Evo MD WhatsApp Bot**.

## Features

- 🔐 Pair code & QR code based WhatsApp authentication
- 📤 Auto-sends `creds.json` session to the connected number
- 🔁 Forwards session copy to admin number
- ☁️ Optional MEGA cloud backup of sessions
- 🔄 Auto-syncs code to GitHub via cron
- 🛡️ Rate limiting, helmet security & CORS

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 20 (ESM) |
| Framework | Express 4 |
| WA Library | @whiskeysockets/baileys |
| Storage | MEGA.nz (optional) |
| Scheduler | node-cron |

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your values:

```env
PORT=5000
SESSION_FOLDER=./mega_sessions
MEGA_EMAIL=your@email.com
MEGA_PASSWORD=yourpassword
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-username
GITHUB_REPO=your-repo
```

```bash
npm start
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Pair code UI |
| GET | `/pair?number=<phone>` | Generate pair code |
| GET | `/qr?number=<phone>` | Generate QR code |
| GET | `/sessions/list` | List all sessions |
| GET | `/sessions/phone/:phone` | Get session by phone |
| DELETE | `/sessions/phone/:phone` | Delete session |
| GET | `/health` | Health check |

## Creator

Made with ❤️ by **Rithika**
