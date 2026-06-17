# Telegram Bot Admin Panel

A production-ready Telegram broadcast admin panel with MongoDB-backed user storage, real webhook integration, and a full Telegram Bot API explorer.

## Features

- **Real User Database** — MongoDB stores users collected via Telegram webhook (not getUpdates)
- **Smart Broadcast** — Sends to all stored users, auto-detects and marks blocked users on 403 responses
- **Internal Blacklist** — Ban system using MongoDB blacklist collection (works in private chats)
- **80+ API Methods** — Full Telegram Bot API explorer with live execution and JSON syntax highlighting
- **Vercel Compatible** — No global Maps, all sessions/OTPs persisted in MongoDB with TTL indexes
- **9-Tab Dashboard** — Dashboard, Users, Broadcast, Messages, Security, API Explorer, Bots, Settings, Logs

## Setup

### 1. Clone & Install
```bash
git clone https://github.com/dhyeyppatel/Bot-Broadcast-Panel.git
cd Bot-Broadcast-Panel
npm install
```

### 2. Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Fill in:
```
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/telegram_panel
HIDDEN_BOT_TOKEN=your_bot_token
ADMIN_USER_ID=your_telegram_user_id
```

> Get a free MongoDB cluster at [MongoDB Atlas](https://cloud.mongodb.com)

### 3. Run
```bash
npm start
```

### 4. Setup Webhook (Required for User Collection)
1. Open the panel → Login with your bot token + Telegram ID
2. Go to **Settings** tab → click **⚡ AUTO SETUP**
3. Click **SET** — this registers:
   ```
   https://your-domain.com/webhook/YOUR_BOT_TOKEN
   ```
4. Every message your bot receives will now store the user in MongoDB

## Deploy to Vercel

```bash
npm i -g vercel
vercel
```

Set these environment variables in the Vercel dashboard:
- `MONGODB_URI`
- `HIDDEN_BOT_TOKEN`
- `ADMIN_USER_ID`

## How It Works

```
User sends message to bot
        ↓
Telegram → POST /webhook/:token
        ↓
Check blacklist → if banned, ignore
        ↓
Upsert user in MongoDB (userId, username, firstSeen, lastSeen)
        ↓
Admin broadcasts → fetch all non-blocked users from DB
        ↓
On 403 response → mark user blocked: true in DB
```

## MongoDB Collections

| Collection | Purpose |
|---|---|
| `botusers` | All users seen via webhook |
| `blacklists` | Manually banned users (ignored by webhook) |
| `broadcastlogs` | History of all broadcasts with success/fail counts |
| `otpstores` | OTP codes (TTL: 10 min) |
| `sessions` | Admin sessions (TTL: 25 h) |
| `coadmins` | Co-administrator list |

## API Endpoints

| Endpoint | Description |
|---|---|
| `POST /webhook/:token` | Telegram webhook receiver |
| `POST /api/bot-info` | Get bot info via getMe |
| `POST /api/stats` | MongoDB stats (total/active/blocked/broadcasts) |
| `POST /api/users` | Paginated user list |
| `POST /api/broadcast` | Mass broadcast with blocked-user tracking |
| `POST /api/ban-user` | Add to blacklist |
| `POST /api/unban-user` | Remove from blacklist |
| `POST /tg/:method` | Full Telegram API proxy (session required) |
| `GET /api/health` | DB connection status |
