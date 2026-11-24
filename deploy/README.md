# Deploying to an existing server (Docker)

For a server that **already has a reverse proxy (nginx, Caddy, ...) and Postgres** and runs other systems: only one new backend container is added, reusing the existing gateway and database.

> BANWAGONG has no Docker and only 512 MB of RAM; it runs a native binary under systemd instead. See [banwagong/README.md](banwagong/README.md).

```
Browser (web app on GitHub Pages)
        │ HTTPS
        ▼
Existing gateway (nginx / Caddy) ──► new: ai-homework container (127.0.0.1:8787)
                                         │
                                         ▼
                          new ai_homework database in the existing Postgres
```

## 1. Image

After a push to `main`, GitHub Actions (`.github/workflows/image.yml`) builds the image and publishes it to `ghcr.io/bryht/ai-homework-system:latest`. The server only pulls the image; Rust is never compiled on a small VPS.

After the first build, set the package to public under GitHub **Packages → ai-homework-system → Package settings**, or run `docker login ghcr.io` on the server with a token that has `read:packages`.

## 2. Database

Create a dedicated user and database in the existing Postgres (change the password first):

```bash
sudo -u postgres psql -f postgres-setup.sql
```

If Postgres runs directly on the host (not in Docker), it must also accept connections from the Docker bridge; see the comments at the end of `postgres-setup.sql`. The app creates its tables on start and does not touch other systems' databases.

## 3. Backend

Copy this directory to the server, e.g. `/opt/ai-homework/`:

```bash
cp env.example .env
```

Fill in `DATABASE_URL`, a model key (`OLLAMA_API_KEY` or `DEEPSEEK_API_KEY`) and `CORS_ORIGINS` in `.env`, then:

```bash
docker compose pull && docker compose up -d
```

```bash
docker compose exec app ai-homework create-teacher --username wang --name "Mr. Wang"
```

The container only listens on `127.0.0.1:8787`; outside access goes through the gateway.

## 4. Gateway

Add one route to the existing gateway, either:

- **a subdomain** (recommended): `homework-api.example.com` → `127.0.0.1:8787`
- **a path on an existing domain**: `https://example.com/homework/` → `127.0.0.1:8787` (strip the `/homework` prefix)

See `nginx.conf.example` and `Caddyfile.example`. Response buffering must be off (AI replies stream), and the upload limit raised to 32 MB.

## 5. Web app

Set the GitHub repository variable `API_ORIGIN` to the address from the previous step (`https://homework-api.example.com` or `https://example.com/homework`), then run the Pages workflow.

## Updating

```bash
docker compose pull && docker compose up -d
```

## Backups

Back up the `ai_homework` database the same way as the other systems' databases. Uploaded files are in the Docker volume `uploads`:

```bash
docker run --rm -v ai-homework_uploads:/data -v "$PWD":/backup debian tar czf /backup/uploads.tgz -C /data .
```
