# Local Development Guide

Tachboard is a **self-hosted** dashboard app. Its API Server makes the real requests
to your homelab services (TrueNAS, Sonarr, Radarr, qBittorrent, Jellyfin, …).
Those services live on LAN addresses (`192.168.x.x`, `10.x.x.x`, Tailscale /
MagicDNS names) that **Replit's cloud cannot route to** — so on Replit every
connection test times out.

The fix is a workflow, not a code change:

> **Edit on Replit → push to Git → pull on a box inside your home network →
> run it there.** Because the API Server now runs *inside* the LAN, connections
> resolve against the real services and the tiles show live data.

This guide covers the whole loop.

---

## 1. Prerequisites (on your local box)

The local box must be **inside your home network** (or on your Tailnet) so it can
reach your services.

- **Node.js 20 or newer** — the production Docker image uses `node:20-alpine`;
  Replit uses Node 24. Anything `>=20` works.
- **pnpm 10** — `npm install -g pnpm@10`
- **Git**
- *(Production-parity path only)* **Docker** + **Docker Compose v2**

---

## 2. Git setup (one time)

You keep editing on Replit and pull the changes onto the local box.

### a. Create a remote
Create an empty repository on GitHub (or any Git host). Don't add a README so the
first push is clean.

### b. Connect the Replit project to it
In the Replit workspace, open the **Git** pane and connect/push to the remote you
just created. (Git on Replit is managed through the UI — you don't run `git` in the
Replit shell.)

### c. Clone onto the local box
```bash
git clone <your-remote-url> tachboard
cd tachboard
pnpm install
```

### The day-to-day loop
1. Make changes **on Replit** (this is your editor).
2. Commit & push from the Replit **Git** pane.
3. On the local box:
   ```bash
   git pull
   pnpm install   # only when dependencies changed
   ```
4. Run it locally (next section) and test against your real services.

---

## 3. Running locally

There are two ways to run. Use **fast dev** while iterating, and **Docker** when
you want to verify the exact thing you'll actually deploy.

### a. Fast dev (hot reload) — recommended while iterating

One command from the repo root:

```bash
pnpm run dev:local
```

This starts both services together with hot reload:

| Service       | Port (default) | Reload                                   |
|---------------|----------------|------------------------------------------|
| API Server    | `20027`        | rebuilds + restarts on file change       |
| Dashboard     | `20026`        | Vite HMR (instant)                       |

Then open **http://localhost:20026**.

The dashboard calls the API with relative `/api/...` paths. In dev, Vite proxies
`/api` straight to the API Server on port `20027`, so there are no 404s and no
manual proxy fiddling.

**Overriding ports / proxy target** (optional):

```bash
API_PORT=5050 WEB_PORT=3000 pnpm run dev:local
# Point the dashboard's /api proxy somewhere else entirely:
VITE_API_PROXY_TARGET=http://localhost:5050 pnpm --filter @workspace/homelab-dashboard run dev
```

> Prefer two terminals? It's the same thing split apart:
> ```bash
> # terminal 1 — API Server (rebuilds + restarts on change)
> cd artifacts/api-server
> NODE_ENV=development PORT=20027 DATA_DIR=./data pnpm run dev:watch
>
> # terminal 2 — dashboard (Vite, proxies /api -> :20027)
> cd artifacts/homelab-dashboard
> PORT=20026 VITE_API_PROXY_TARGET=http://localhost:20027 pnpm run dev
> ```

### b. Production parity — `docker compose`

Runs the exact single-container production build (Express serves both the frontend
and `/api` on one port). Use this to sanity-check a release before deploying it.

```bash
docker compose up --build
```

Then open **http://localhost:20028** (override with `PORT=8080 docker compose up --build`).

Persisted data (SQLite DB, uploads, generated JWT secret) lives in the
`homelab-data` Docker volume. Optional service credentials can be set via
environment variables — see the commented block in `docker-compose.yml`.

**When to use which**

| Situation                                         | Use            |
|---------------------------------------------------|----------------|
| Building a feature, want instant feedback         | `dev:local`    |
| Verifying the real deployable image before ship   | `docker compose up --build` |

---

## 4. Pointing connections at your real services

Connections are configured **in the app**, not in code:

1. Run the app locally (either path above) on the box inside your LAN.
2. Log in (register an account on first run), open **Settings**.
3. For each service, enter its **real LAN or Tailscale address**, e.g.
   - `http://192.168.1.10` (TrueNAS)
   - `http://192.168.1.20:8989` (Sonarr)
   - `http://media.tailnet-name.ts.net:8096` (Jellyfin over Tailscale)
   plus its API key / credentials.
4. Use **Test connection** — it should now succeed (it's the API Server *on your
   box* making the request, so the address resolves).
5. Back on the dashboard, the corresponding tiles should show **live data**.

If a test still fails, confirm the box itself can reach the service
(`curl http://<address>/...` from that box). If the box can't reach it, the app
can't either — that's a network/firewall/Tailscale issue, not an app bug.

---

## 5. Gotchas

- **Why the `/api` Vite proxy exists.** The frontend always uses relative
  `/api/...` URLs. On Replit, the platform's path-based router proxies `/api` to
  the API Server artifact. On a local box that platform router doesn't exist, so
  Vite's dev-server proxy bridges `/api` → the local API Server instead. The proxy
  is **dev-only** (it only applies to `vite dev`) and is **disabled on Replit**
  (gated on `REPL_ID`), so it never interferes with the platform router. URLs stay
  relative on purpose so the same frontend build also works in the Docker
  single-container setup, where Express serves both the app and `/api`.

- **`DATA_DIR` differs by environment.** In local dev it defaults to `./data`
  (i.e. `artifacts/api-server/data`). In Docker it's `/data` (a mounted volume).
  Don't hardcode `/data` locally — it only exists inside the container.

- **Local data is independent of Replit.** The SQLite database, uploaded images,
  and the auto-generated JWT secret are **gitignored**, so they never sync through
  Git. Your local box keeps its own users, settings, and connections, separate
  from anything on Replit. (Deleting `artifacts/api-server/data/` resets local
  state.)

- **`PORT` is required by the API Server.** It throws on startup if `PORT` is
  unset. `dev:local` and the Docker setup set it for you; if you run the API
  Server by hand, pass `PORT`.
