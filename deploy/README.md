# Staging on a LAN VPS behind a Cloudflare Tunnel

This is the staging deployment, not the production hardening milestone. It
runs the same code as development inside containers, on a VPS that sits on a
LAN address with a dynamic public IP. That combination works because a
Cloudflare Tunnel connects **outbound** from the VPS to Cloudflare: no port
forwarding, no static public IP and no inbound firewall rule are needed.

## Prerequisites (on the VPS)

- Docker Engine + Docker Compose v2
- git
- cloudflared (only for the tunnel step, done by the owner)

## 1. Get the code and configure

```bash
git clone https://github.com/hieupt91-sketch/3t-web-marketplace.git
cd 3t-web-marketplace/deploy
cp .env.example .env
```

Edit `.env` and fill in every `change-me` value. Generate the secrets with
`openssl rand -hex 32` (a different value per secret). Two values need care:

- `DB_PASSWORD` — the database password. It is used both by postgres and by
  the app containers, so keep it in this one file only.
- `PORTAL_ORIGIN` — the public URL visitors will use through the tunnel,
  `https://webmaket.com`. It must match the tunnel hostname
  exactly, or logins and form posts fail with `origin_mismatch`.

`PREVIEW_BASE_DOMAIN` must be a different host from the portal host:
`preview.webmaket.com` when the portal is `webmaket.com`.

## 2. Start the stack

Every command below runs from the `deploy/` directory:

```bash
docker compose --env-file .env up -d --build
docker compose exec api pnpm --filter @3t/api migrate
```

Create the owner account (it prompts for a password; the prompt needs a
terminal, so run it with `-it`):

```bash
docker compose exec -it -e OWNER_EMAIL=you@example.com api pnpm --filter @3t/api run create-owner
```

Check health:

```bash
docker compose ps
curl -s http://127.0.0.1:3000/ | head -c 200
docker compose logs -f api web
```

## 3. Point the tunnel (owner step)

```bash
cloudflared tunnel login
cloudflared tunnel create web-marketplace
```

This prints a tunnel ID and writes a credentials file. Then, in the
Cloudflare dashboard for your domain, add two DNS routes for that tunnel:

- `webmaket.com`
- `*.preview.webmaket.com` (wildcard — without it the main site works but
  every demo preview fails to load)

Copy `cloudflared.example.yml` to `cloudflared.yml`, replace `<TUNNEL_ID>`
and the hostnames, and run:

```bash
cloudflared tunnel run --config cloudflared.yml web-marketplace
```

To survive reboots, install it as a service instead:

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
```

If the tunnel hostname changes later, update `PORTAL_ORIGIN` in `.env` to
the new URL and restart the app containers:

```bash
docker compose --env-file .env up -d api web
```

## 4. Update the staging stack

```bash
git pull
docker compose --env-file .env up -d --build
docker compose exec api pnpm --filter @3t/api migrate
```

## 5. Back up and restore

Back up the database and the shared app data (uploads, bundles, work files):

```bash
docker compose exec postgres pg_dump -U marketplace marketplace > backup.sql
docker volume ls | grep appdata   # usually deploy_appdata
docker run --rm -v deploy_appdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/appdata.tar.gz -C /data .
```

Restore the database into a fresh stack (stop the app containers first):

```bash
docker compose stop api worker web preview
cat backup.sql | docker compose exec -T postgres psql -U marketplace marketplace
docker compose start api worker web preview
```

## 6. Stop

```bash
docker compose down        # stops containers, keeps data volumes
docker compose down -v     # DANGER: also deletes the database and app data
```

## What staging deliberately does not have yet

- Mail is disabled (`MAIL_TRANSPORT=disabled`), so no password-reset emails
  are sent on staging. A real mail provider replaces this before production.
- Payments are still the sandbox mock. A real provider replaces this before
  any real selling.
- Screenshots are off. They need a Chromium binary in the worker image.
- TLS comes from Cloudflare (the tunnel), not from ACME on the VPS.
- The Node services run from TypeScript source with tsx, as in development.
  Compiled production builds are a later hardening step.
- There is no alert channel yet: if the stack stops, nobody is notified
  automatically. Check `docker compose ps` after any VPS reboot.

## Troubleshooting

- `origin_mismatch` on login or form posts: `PORTAL_ORIGIN` in `.env` does
  not equal the tunnel hostname. Fix it and restart api + web.
- Main site works but demos show an error: the wildcard tunnel route
  (`*.preview.webmaket.com`) is missing or points elsewhere.
- `api` keeps restarting: run `docker compose logs api` — the usual cause
  is a wrong `DB_PASSWORD` or a missing required secret in `.env`.
- Pages load but images/uploads are missing after a rebuild: the `appdata`
  volume must be shared by api, worker and preview (it is, in
  `docker-compose.yml`). Do not mount separate volumes per service.
