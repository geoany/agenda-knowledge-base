# SETUP.md: running agenda-knowledge-base on your own server

This guide puts the app online on a Linux server under your own domain, with
HTTPS, a nightly job, voice dictation, the Google Calendar mirror and the MCP
servers. Paths below use `/opt/agenda-knowledge-base`; adapt them.

## 1. Requirements

- Linux server (a small VPS is enough: the app uses a few tens of MB of RAM;
  all model work happens on the LLM provider's side).
- Node.js 22 or later (developed on 22.x). `better-sqlite3` ships prebuilt
  binaries for common platforms; otherwise install `build-essential` and
  `python3`.
- A domain name pointing to the server, and a reverse proxy for HTTPS (Caddy,
  nginx or Traefik, examples below).
- An API key for an OpenAI-compatible LLM endpoint with tool calling.
- Optional: a Mistral API key (voice dictation), Google Calendar secret iCal
  URLs, Claude Code installed on the server (worker button).

## 2. Install and build

```bash
sudo mkdir -p /opt/agenda-knowledge-base && sudo chown "$USER" /opt/agenda-knowledge-base
git clone <repository-url> /opt/agenda-knowledge-base   # URL in README.md
cd /opt/agenda-knowledge-base
npm ci
npm run build        # npm ci + vite build in web/, output in web/dist
```

The server serves `web/dist` itself; no separate static hosting is needed.

## 3. Configure

```bash
cp .env.example .env
chmod 600 .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste as AGENDA_TOKEN
```

Edit `.env`. The important variables:

| Variable | Purpose |
|---|---|
| `AGENDA_TOKEN` | the only credential of the app, API and MCP bridge (required) |
| `HOST`, `PORT` | listen address, `127.0.0.1:8137` by default |
| `TZ` | your time zone; "today" is computed on the process clock |
| `AGENDA_LLM_URL`, `AGENDA_LLM_API_KEY`, `AGENDA_MODEL` | the agent's model |
| `AGENDA_VISION_MODEL` | model used to describe attached images |
| `MISTRAL_API_KEY` | voice dictation |
| `AGENDA_GCAL_ICS` | Google Calendar secret iCal URLs, comma-separated |
| `AGENDA_USER_NAME` | optional first name used in the agent's prompt |
| `AGENDA_DATA_DIR` | where databases, notes and uploads live (`./data`) |

Every variable is documented in `.env.example`. The server reads `.env` from
the project directory by itself (`AGENDA_ENV_FILE` points elsewhere); variables
set by systemd or the shell take precedence over the file.

## 4. Data directory and first run

```bash
npm start
# agenda on http://127.0.0.1:8137
```

On first start the server creates `data/` with `todo.db` (tasks, rules, facts,
chat, history), `kb.db` (knowledge base index), `kb/` (your notes), `files/`
(uploads) and `workers/` (worker logs). Nothing else is needed: schemas are
created and migrated automatically.

Optional, to start with the example notes:

```bash
mkdir -p data/kb && cp -r examples/kb/* data/kb/
```

Check it, then stop it with Ctrl+C:

```bash
curl -s http://127.0.0.1:8137/health
curl -s -H "Authorization: Bearer $AGENDA_TOKEN" http://127.0.0.1:8137/api/bootstrap | head -c 200
```

## 5. systemd service

A user unit (no root needed to manage it). Create
`~/.config/systemd/user/agenda.service`:

```ini
[Unit]
Description=agenda-knowledge-base
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/agenda-knowledge-base
# .env is loaded by the app itself; values set here win over it.
Environment=TZ=Europe/Paris
Environment=HOST=127.0.0.1
Environment=PORT=8137
# The worker button spawns `claude`: make sure its directory is on PATH.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
loginctl enable-linger "$USER"          # keep user services running after logout
systemctl --user daemon-reload
systemctl --user enable --now agenda
systemctl --user status agenda
journalctl --user -u agenda -f
```

A system unit works the same way (`/etc/systemd/system/agenda.service`, add
`User=<you>`, `WantedBy=multi-user.target`, manage with `sudo systemctl`).

## 6. Reverse proxy, domain and HTTPS

Point an `A`/`AAAA` record (for example `agenda.example.com`) to the server,
then put a reverse proxy in front of `127.0.0.1:8137`. Two things matter for
this app:

- `/api/events` is a Server-Sent Events stream: disable response buffering and
  allow long-lived connections (the server sends a heartbeat every 25 s).
- Uploads and voice recordings are sent as raw bodies up to about 32 MB.

### Caddy

```
agenda.example.com {
    reverse_proxy 127.0.0.1:8137 {
        flush_interval -1
    }
    request_body {
        max_size 32MB
    }
}
```

Caddy obtains and renews the certificate itself.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name agenda.example.com;
    ssl_certificate     /etc/letsencrypt/live/agenda.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agenda.example.com/privkey.pem;

    client_max_body_size 32m;

    location /api/events {
        proxy_pass http://127.0.0.1:8137;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:8137;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 10m;
    }
}
```

Certificates: `sudo certbot --nginx -d agenda.example.com`.

### Traefik (Docker)

The app runs on the host, Traefik in a container. Make the app listen on the
Docker bridge gateway so that only containers (not the internet) can reach it:
set `HOST=172.17.0.1` (check with `ip -4 addr show docker0`, or the gateway of
Traefik's own network) and allow that subnet in your firewall if you use one
(`ufw allow from 172.17.0.0/16 to any port 8137`). Then add a file-provider
route, for example `dynamic/agenda.yml`:

```yaml
http:
  routers:
    agenda:
      rule: Host(`agenda.example.com`)
      entryPoints: [websecure]
      service: agenda
      tls:
        certResolver: letsencrypt
  services:
    agenda:
      loadBalancer:
        servers:
          - url: http://172.17.0.1:8137
```

Traefik streams SSE without extra configuration. With `HOST` set to the
gateway, the MCP bridge (`mcp/agenda.js`) reaches the service at
`http://$HOST:$PORT` by default; `AGENDA_URL` overrides it if needed.

## 7. Access token and sessions

There is a single shared secret, `AGENDA_TOKEN`; there are no user accounts.

- Open `https://agenda.example.com/?t=<AGENDA_TOKEN>` once on each device. The
  front stores the token in `localStorage` and removes it from the address bar.
  Without a token, the app shows a screen where you paste it.
- The server also sets an `HttpOnly`, `Secure`, `SameSite=Lax` cookie
  (`agenda_session`) on every authenticated call. Browsers cap cookie lifetime
  at 400 days, and each visit pushes the expiry again, so a device that is used
  from time to time never asks again. The cookie is `Secure`: serve the app over
  HTTPS (plain `http://127.0.0.1` works for local use).
- API clients send `Authorization: Bearer <token>` (or `x-todo-token`).
- To revoke every device: change `AGENDA_TOKEN` and restart.

Anyone with the token has full access, including the worker button (which runs
a CLI on your server). Keep it long, random and private.

## 8. Install the PWA on a phone

- iPhone (Safari): open the URL, Share, "Add to Home Screen". The installed app
  has its own storage: on first launch, paste the token in the token screen.
- Android (Chrome): open the URL with `?t=`, menu, "Install app".

The service worker only caches the app shell; tasks are always read from the
network.

## 9. Google Calendar mirror

In Google Calendar: Settings, select the calendar, "Integrate calendar",
copy "Secret address in iCal format". Put it in `AGENDA_GCAL_ICS` (several
calendars: comma-separated) and restart. Events appear as ordinary tasks
(source `gcal`), synced at startup and every 15 minutes, read-only (deleting
one here hides it, it does not delete it in Google). Force a sync or check the
state:

```bash
curl -X POST -H "Authorization: Bearer $AGENDA_TOKEN" http://127.0.0.1:8137/api/gcal/sync
curl -H "Authorization: Bearer $AGENDA_TOKEN" http://127.0.0.1:8137/api/gcal
```

The secret URL is a credential: anyone who has it can read the calendar. It can
be reset from the same Google settings page.

## 10. Voice dictation and vision

- Dictation: set `MISTRAL_API_KEY`. The browser records audio, the server sends
  it to Mistral Voxtral (`AGENDA_STT_MODEL`, default `voxtral-mini-latest`); the
  key never reaches the browser. `AGENDA_STT_LANGUAGE` forces the language
  (default `fr`, empty for auto-detection) and `AGENDA_STT_PROMPT` lists proper
  nouns you say often. Without the key, the microphone button is hidden.
  Microphone access requires HTTPS.
- Vision: an attached image is described once, at upload, by
  `AGENDA_VISION_MODEL` on `AGENDA_VISION_URL` (default: the LLM endpoint, same
  key, OpenAI `image_url` format). The agent reads the description, never the
  image.

## 11. Nightly job

The night routine (tidy-up of unfinished tasks, small reversible gestures,
detectors, weaving of new knowledge base notes) runs when something calls
`POST /api/night`. Run it once a night with cron (`crontab -e`):

```cron
CRON_TZ=Europe/Paris
0 1 * * * cd /opt/agenda-knowledge-base && curl -fsS -m 600 -X POST -H "Authorization: Bearer $(sed -n 's/^AGENDA_TOKEN=//p' .env)" -H "content-type: application/json" -d '{}' http://127.0.0.1:8137/api/night >> "$HOME/agenda-night.log" 2>&1
```

`-f` makes curl fail on an HTTP error, so failures land in the log. A failed
night also lights an "agent down" badge in the app header. Calling the route
twice the same day does nothing the second time (send `{"force": true}` to
replay). Before noon, the routine tidies up the previous day.

The in-process clock handles the rest (calendar sync every 15 minutes, purge
of old gesture rows); no other cron is needed.

## 12. MCP servers in Claude Code

On the machine where Claude Code runs (the same server, since `mcp/agenda.js`
reads the SQLite file directly):

```bash
claude mcp add --scope user agenda -- node /opt/agenda-knowledge-base/mcp/agenda.js
claude mcp add --scope user kb -- node /opt/agenda-knowledge-base/mcp/kb.js
claude mcp list
```

Both servers load `/opt/agenda-knowledge-base/.env` themselves. `agenda` reads
tasks directly and sends writes as natural language to the running service
(`agenda_message` posts to `/api/chat` with the token and waits for the
answer, up to 10 minutes); it needs the service to be up. Its messages go to a
hidden conversation that does not appear in the app's chat list. `kb` reads and
writes the notes directly and does not need the service.

## 13. Worker button (optional)

The wrench in the top bar sends a task, with an optional instruction, to a
detached headless run of Claude Code on the server
(`claude -p ... --dangerously-skip-permissions --max-turns N`). It runs as the
service's user, in `AGENDA_WORKER_CWD` (default: the project directory), and is
killed after `AGENDA_WORKER_TIMEOUT_MS`. The worker can update the task through
the `agenda` MCP server. Configure:

```bash
AGENDA_WORKER_CMD=claude                 # or an absolute path
AGENDA_WORKER_CWD=/home/you/projects     # where it is allowed to work
AGENDA_WORKER_CHEAP_MODEL=               # optional, model of the "cheap model" worker
```

The pop-up offers a second worker, "Claude Code · cheap model": the same
`claude` binary with `--model <model>`. If `OPENCODE_GO_API_KEY` is set, it runs
on OpenCode Go (`deepseek-v4.1-flash` by default): Claude Code is pointed at
`https://opencode.ai/zen/go` with that key, and the `CLAUDE*` / `ANTHROPIC*`
variables of the service are not passed on (an inherited claude.ai token would
get a 401). Otherwise it stays on Anthropic with `claude-haiku-5-5`.
`AGENDA_WORKER_CHEAP_MODEL` overrides the model in both cases.

Only enable this on a server you own: it runs with permissions skipped.

## 14. Backups

SQLite runs in WAL mode: do not copy `todo.db` with `cp` while the service runs,
use the online backup API.

```bash
cd /opt/agenda-knowledge-base
mkdir -p ~/backups
node -e "require('better-sqlite3')('data/todo.db', { readonly: true }).backup(process.argv[1])" ~/backups/todo-$(date +%F).db
tar czhf ~/backups/kb-$(date +%F).tgz -C data kb files
cp .env ~/backups/env-$(date +%F)    # contains secrets, store accordingly
```

`kb.db` does not need a backup: it is rebuilt from `data/kb/` at startup (or
`POST /api/kb/reindex`).

## 15. Updating

```bash
cd /opt/agenda-knowledge-base
git pull
npm ci
npm run build
systemctl --user restart agenda
```

Schema changes are applied automatically at startup. An open browser tab
notices the new front-end build and reloads itself.

## 16. Troubleshooting

- **401 everywhere / token screen keeps coming back**: wrong token, or the site
  is served over plain HTTP so the `Secure` cookie is dropped. Use HTTPS.
- **Live updates and chat steps do not arrive**: the proxy buffers
  `/api/events`. Disable buffering for that path (see the nginx example).
- **502 / timeout from the proxy**: the app listens on `127.0.0.1` while the
  proxy runs in a container; set `HOST` to the Docker gateway and open the port
  to the Docker subnet only.
- **"agent down" badge, or "I could not answer: ..." in the chat**: the LLM
  call failed. Check `AGENDA_LLM_URL`, the key and the model name; a 404/410
  means the model was retired (set `AGENDA_MODEL_FALLBACK`). Logs:
  `journalctl --user -u agenda`.
- **Tasks dated the day before around midnight**: `TZ` is not set to your time
  zone.
- **Calendar sync returns an HTML page / 429**: Google sometimes rate-limits by
  IP; the code already forces IPv4. Check the URL is the secret iCal address.
- **Worker "not found"**: the service's `PATH` does not contain the CLI; set an
  absolute path in `AGENDA_WORKER_CMD`.
- **`agenda_message` fails from Claude Code**: the service is not reachable at
  `http://HOST:PORT`; set `AGENDA_URL`.
- **`better-sqlite3` fails to install**: no prebuilt binary for your Node
  version or platform; install a toolchain (`build-essential`, `python3`) and
  run `npm ci` again.
