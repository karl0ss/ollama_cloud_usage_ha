# Ollama Cloud Usage Server

Lightweight Node.js server that pulls your Ollama cloud usage from `ollama.com/settings` and serves it as a JSON API + web dashboard. Runs fine on headless servers. Can optionally push metrics to Home Assistant.

**No browser required on the server** — just HTTP requests with cookie management.

## Setup

```bash
cp .env.example .env   # Edit with your settings
npm install
npm start
```

## Web Dashboard

Open `http://localhost:3214` in your browser for a built-in dashboard that shows:

- Current session and weekly usage with progress bars
- Per-model request breakdowns
- A form to paste/update cookies without curl
- Server health info (auth mode, poll interval, last fetch)

## Authentication

Pick one:

### Option 1: Email/Password (if your account has a password)

Add to `.env`:
```
AUTH_MODE=email
OLLAMA_EMAIL=you@example.com
OLLAMA_PASSWORD=your-password
```

The server will log in automatically and manage session cookies. If you signed up with Google OAuth and never set a password, skip to Option 2.

### Option 2: Export cookies from your browser (for Google/GitHub sign-ins)

**Using a cookie extension** like [EditThisCookie](https://editthiscookie.com/) or [Cookie-Editor](https://cookie-editor.com/):
1. Install the extension, log into ollama.com
2. Export cookies for ollama.com as JSON
3. POST the JSON array to the server:

```bash
curl -X POST http://localhost:3214/api/cookies \
  -H "Content-Type: application/json" \
  -d @cookies.json
```

Or paste them directly in the web dashboard at `http://localhost:3214`.

**Or grab them manually from DevTools:**
1. Log into ollama.com in your browser
2. Open DevTools → Application → Cookies → `https://ollama.com`
3. Copy each cookie's name/value and POST as JSON

Cookies get saved to `.cookies.json` (next to `server.js`) and reused automatically. They'll expire eventually — when that happens, just re-export and POST them again.

**Set in `.env`:**
```
AUTH_MODE=cookies
```

## API Endpoints

| Endpoint | Method | What it does |
|---|---|---|
| `/` | GET | Web dashboard |
| `/api/usage` | GET | Latest usage data from last poll |
| `/api/usage/refresh` | GET | Force a fresh poll right now |
| `/api/health` | GET | Server status and config |
| `/api/cookies` | POST | Upload new cookies (JSON array) |

### Example response (`/api/usage`)

```json
{
  "session": {
    "percent": 9.2,
    "resetsIn": "2 hours",
    "models": [
      { "model": "gemma3", "requests": 14 },
      { "model": "llama3", "requests": 3 }
    ]
  },
  "weekly": {
    "percent": 32.9,
    "resetsIn": "3 days",
    "models": [
      { "model": "gemma3", "requests": 142 },
      { "model": "llama3", "requests": 37 }
    ]
  },
  "fetchedAt": "2026-05-07T13:08:44.194Z"
}
```

## Home Assistant Integration

### Option A: Automatic push

Set `HA_URL` and `HA_TOKEN` in `.env`. After every poll, the server pushes to these sensors (HA creates them automatically):

| Sensor | Description |
|---|---|
| `sensor.ollama_session_usage` | Session usage % |
| `sensor.ollama_session_models` | Number of models used this session (attributes include per-model request counts) |
| `sensor.ollama_weekly_usage` | Weekly usage % |
| `sensor.ollama_weekly_models` | Number of models used this week (attributes include per-model request counts) |

### Option B: REST sensor (pull from HA side)

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
| `POLL_MINUTES` | 30 | How often to poll (minutes) |
| `HA_URL` | — | Home Assistant URL (no trailing slash) |
| `HA_TOKEN` | — | HA long-lived access token |
| `COOKIE_FILE` | `.cookies.json` | Where to store cookies (defaults next to server.js) |

## Updating Cookies

When cookies expire, just re-export from your browser and POST again — it replaces the old ones:

```bash
curl -X POST http://localhost:3214/api/cookies \
  -H "Content-Type: application/json" \
  -d @fresh-cookies.json
```

Or use the web dashboard at `http://localhost:3214`.

Server logs will show `needsLogin` when cookies have expired.

## Running as a Service

```bash
# Using pm2
npm install -g pm2
pm2 start server.js --name ollama-usage
pm2 save
pm2 startup
```