# cine-server

Runtime for the cine-player streaming CMS (companion to
[devrahmanbd/cine-player](https://github.com/devrahmanbd/cine-player)).
GPL-2.0.

## Contents

| File | Role |
|---|---|
| `server.js` | Streaming engine (:11470) — torrent/HLS/transmux/probe bundle. Opaque upstream artifact; do not edit. |
| `native-web.js` | Prod web server — serves `../stremio-linux/build`, proxies `/api/*` → `:3001` and streaming paths → `:11470`. Zero deps. |
| `data/` | **Not in git** (see `.gitignore`) — live `brand.db` + `uploads/`. Back this directory up separately. |

## Run

Requires system node >= 22. Environment:

- `PORT` (api, default 3001), `DB_PATH` (default `./data/brand.db`),
  `UPLOADS_DIR`, `ADMIN_USER`, `ADMIN_PASSWORD`, `SITE_NAME`

See `cine-player` (`api/`, launchd plists) for the service wiring.
On this host the services run via launchd (`io.linuxstream.web/api/server`).
