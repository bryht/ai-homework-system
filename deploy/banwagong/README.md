# Deployment on BANWAGONG

The server (Ubuntu 20.04, 512 MB RAM, 1 CPU) has **no Docker**. The gateway is nginx on the host (`api.bryht.net`, routing by path to each backend) and Postgres 12 runs on the host too. The other systems there (sticky-notes, brushup) are native binaries in `/opt/<app>` managed by systemd. AI Homework is deployed the same way and is never compiled on the server.

| What | Where |
| --- | --- |
| Public address | `https://api.bryht.net/homework` (GitHub variable `API_ORIGIN`) |
| Web app | `https://homework.bryht.net` (GitHub Pages) |
| Binary | `/opt/ai-homework/ai-homework` (static musl build) |
| Settings | `/opt/ai-homework/.env` (`root:www-data`, 640) |
| Uploaded files | `/opt/ai-homework/data` |
| Service | `ai-homework.service` ([ai-homework.service](ai-homework.service)), port 8787, closed to the internet by ufw |
| Database | `ai_homework` database and user in the existing Postgres, separate from the other systems |
| Gateway | `/etc/nginx/snippets/ai-homework.conf` ([nginx-ai-homework.conf](nginx-ai-homework.conf)), included from the `api.bryht.net` server block |

## AI models

Set in `/opt/ai-homework/.env`, then `systemctl restart ai-homework`:

- `OLLAMA_API_KEY`: every chat model on the Ollama account is offered to teachers, who pick one per homework. The list is refreshed every 10 minutes. Ollama models do not take file uploads or web search, so those switches are turned off when a homework uses one.
- `DEEPSEEK_API_KEY`: DeepSeek's own API (DeepSeek Flash, DeepSeek V4 Pro).
- With neither key the built-in mock model is used.

## Updating

Pushing server changes to `main` deploys them: [.github/workflows/server.yml](../../.github/workflows/server.yml) runs the tests, builds a static musl binary and sends it to the server, then checks `https://api.bryht.net/homework/api/health`. It can also be started by hand from the Actions page (**Build and deploy server**).

The workflow logs in with the secret `BANWAGONG_KEY` and runs [ai-homework-deploy](ai-homework-deploy), installed as `/usr/local/sbin/ai-homework-deploy`. That secret should hold the deploy-only key, whose entry is locked to the script:

```
/root/.ssh/authorized_keys:
command="/usr/local/sbin/ai-homework-deploy",restrict ssh-ed25519 AAAA... github-actions-deploy ai-homework
```

The script only reads a binary from stdin, checks it runs (as `www-data`), installs it, restarts the service and puts the previous binary back if the health check fails. The key cannot open a shell. To revoke it, delete that line.

Manual fallback, with Docker Desktop running and a `banwagong` host alias in `~/.ssh/config`:

```powershell
./deploy/banwagong/update.ps1
```

Either way the previous binary is kept as `ai-homework.prev`; to roll back:

```bash
cd /opt/ai-homework && cp -p ai-homework.prev ai-homework && systemctl restart ai-homework
```

## Common commands (on the server)

```bash
systemctl status ai-homework
journalctl -u ai-homework -f
# Create a teacher account (a password is generated and printed when --password is omitted)
cd /opt/ai-homework && sudo -u www-data ./ai-homework create-teacher --username wang --name "Mr. Wang"
```

## Backups

```bash
sudo -u postgres pg_dump -Fc ai_homework > ai_homework.dump
tar czf ai-homework-uploads.tgz -C /opt/ai-homework data
```
