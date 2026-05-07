# Ollama Cloud Usage Server

A lightweight Node.js server that scrapes your Ollama cloud usage from `ollama.com/settings` and exposes it as a JSON API. Works on headless servers. Optionally pushes to Home Assistant.

**No browser on the server needed** — uses pure HTTP requests with cookie management.

## Setup

```bash
cp .env.example .env   # Edit with your settings
npm install
npm start
```

## Authentication

You have two options:

### Option 1: Email/Password (for accounts with a password)

Set in `.env`:
```
AUTH_MODE=email
OLLAMA_EMAIL=you@example.com
OLLAMA_PASSWORD=your-password
```

If your account was created via Google OAuth and has no password set, use Option 2.

### Option 2: Export cookies from your browser (works with Google/GitHub accounts)

Use this if you sign in with Google/GitHub and don't have a password on your Ollama account.

**Using a cookie export extension** (e.g. [EditThisCookie](https://editthiscookie.com/) or [Cookie-Editor](https://cookie-editor.com/)):
1. Install the extension, sign into ollama.com
2. Export cookies for ollama.com as JSON
3. POST the JSON array to the server:

```bash
curl -X POST http://localhost:3214/api/cookies \
  -H "Content-Type: application/json" \
  -d @cookies.json
```

**Using DevTools directly:**
1. Sign into ollama.com in your browser
2. Open DevTools → Application → Cookies → `https://ollama.com`
3. Copy each cookie's name/value and POST as JSON

Cookies are saved to `.cookies.json` and reused across polls. They eventually expire, at which point you'll need to re-export them.

**Set in `.env`:**
```
AUTH_MODE=cookies
```

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/usage` | GET | Latest polled usage data |
| `/api/usage/refresh` | GET | Force a fresh poll right now |
| `/api/health` | GET | Server status and config |
| `/api/cookies` | POST | Upload/replace cookies (JSON array) |

### Example response (`/api/usage`)

```json
{
  "session": {
    "percent": 9.2,
    "resetsIn": "2 hours"
  },
  "weekly": {
    "percent": 32.9,
    "resetsIn": "3 days"
  },
  "fetchedAt": "2026-05-07T13:08:44.194Z"
}
```

## Home Assistant Integration

### Option A: Automatic push

Set `HA_URL` and `HA_TOKEN` in `.env`. The server pushes to `sensor.ollama_session_usage` and `sensor.ollama_weekly_usage` after every poll. Sensors are created automatically in HA — no need to define them manually.

### Option B: REST sensor (pull from HA)

Add to `configuration.yaml`:

```yaml
sensor:
  - platform: rest
    name: Ollama Session Usage
    resource: http://localhost:3214/api/usage
    value_template: "{{ value_json.session.percent | default('unavailable') }}"
    unit_of_measurement: "%"
    state_class: measurement
    json_attributes:
      - session
      - weekly
      - fetchedAt
    scan_interval: 1800

  - platform: rest
    name: Ollama Weekly Usage
    resource: http://localhost:3214/api/usage
    value_template: "{{ value_json.weekly.percent | default('unavailable') }}"
    unit_of_measurement: "%"
    state_class: measurement
    scan_interval: 1800
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AUTH_MODE` | `email` if password set, else `cookies` | `email` or `cookies` |
| `OLLAMA_EMAIL` | — | Email for email auth mode |
| `OLLAMA_PASSWORD` | — | Password for email auth mode |
| `PORT` | 3214 | Server port |
| `POLL_MINUTES` | 30 | Poll interval in minutes |
| `HA_URL` | — | Home Assistant URL (no trailing slash) |
| `HA_TOKEN` | — | HA long-lived access token |
| `COOKIE_FILE` | `.cookies.json` | Path to persist cookies |

## Updating Cookies

When cookies expire, re-export from your browser and POST again — it overwrites the old ones:

```bash
curl -X POST http://localhost:3214/api/cookies \
  -H "Content-Type: application/json" \
  -d @fresh-cookies.json
```

The server logs will show `needsLogin` when cookies have expired.

## Running as a Service

```bash
# Using pm2
npm install -g pm2
pm2 start server.js --name ollama-usage
pm2 save
pm2 startup
```