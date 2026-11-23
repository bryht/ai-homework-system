# AI Homework System

Teachers set homework, and students use the system's built-in AI while they work on it. The system records the whole process (questions, uploaded files, the AI's answers) so teachers can review how the work was done and assess it.

- Design document: [docs/design.md](docs/design.md)
- The web app is adapted from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT)

| Student: homework chat | Teacher: progress | Teacher: conversation replay |
| --- | --- | --- |
| ![](docs/screenshots/student-chat.png) | ![](docs/screenshots/teacher-overview.png) | ![](docs/screenshots/teacher-transcript.png) |

## Features (phase 1)

**Teachers**
- Create classes, add students in bulk (initial passwords are shown once and can be downloaded as CSV), reset passwords
- Set homework: start and due times, instructions (Markdown), draft or published, late submissions allowed or not
- Configure the AI per homework: model, teaching mode (Socratic / explain / open / custom prompt), web search, file uploads, thinking, and a token quota per student
- Try the AI: preview the homework configuration in the student's view
- Progress: questions, tokens, active days, last use and submission status for each student
- Student detail: replay every conversation in order (including regenerated, edited and stopped replies), see attachments and the submission, grade and comment, export CSV

**Students**
- Homework list (open / upcoming / closed, time remaining, submission status)
- Homework chat: the chat-demo experience (streaming answers, thinking, Markdown, formulas, code, file uploads), with the instructions, the due time and a "your teacher can see this conversation" notice at the top
- Submit homework: text, attachments and an honesty statement; editable until the due time

**Server gateway**
- Students' browsers only talk to our server and never see a model API key
- Every request is rewritten according to the homework settings: the teacher's teaching prompt goes first in the system prompt and students cannot override it; web search and thinking are removed when switched off; the time window and quota are checked
- Replies stream to the browser as they arrive, while the question, full answer, usage and latency are stored; uploaded files are kept in their original form

## AI models

Set in `.env` (see [.env.example](.env.example)):

- `OLLAMA_API_KEY`: every chat model on the Ollama account is offered, and teachers pick one per homework. Ollama models do not take file uploads or web search, so those switches are turned off for them.
- `DEEPSEEK_API_KEY`: DeepSeek's own API.
- With neither key, homework uses the **mock model**: it calls no external service and its reply shows the teaching prompt the gateway injected, which makes configuration easy to check.

## Running with Docker Compose (recommended)

Requires Docker (with Compose). From the repository root:

```bash
docker compose up -d --build
```

```bash
docker compose exec app ai-homework seed
```

Open http://localhost:8787 and sign in with a demo account (password `demo1234` for all):

| Account | Role |
| --- | --- |
| `teacher` | Teacher (Ms. Taylor, "Pilot Class") |
| `student1` / `student2` / `student3` | Students |

To use a real model:

```bash
cp .env.example .env
```

Fill in `OLLAMA_API_KEY` or `DEEPSEEK_API_KEY` in `.env`, then restart:

```bash
docker compose up -d
```

Data lives in two Docker volumes: `db-data` (Postgres) and `uploads` (uploaded files). To reset everything:

```bash
docker compose down -v
```

Create a real teacher account (a password is generated and printed when `--password` is omitted):

```bash
docker compose exec app ai-homework create-teacher --username wang --name "Mr. Wang"
```

On the public internet, put HTTPS in front (Caddy, for example) and set `COOKIE_SECURE=true` in `.env`.

## Web app on GitHub Pages (optional)

The web app is static, so it can be hosted on GitHub Pages (free, with HTTPS) while the server runs elsewhere. Sign-in uses a Bearer token in a request header rather than cross-site cookies, so it works in Safari too.

**The server needs a public HTTPS address.** Pages is served over HTTPS, and browsers do not let it call an `http://` server. Options:

- run `docker compose` on a VPS with Caddy in front for automatic certificates, or deploy next to an existing gateway (see [deploy/](deploy/));
- or, temporarily, expose port 8787 with Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8787`; free, but the address changes on every restart).

Setup:

1. Repository **Settings → Pages → Build and deployment → Source**: **GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**: add `API_ORIGIN` with the server's address, e.g. `https://api.example.com`.
3. Allow the Pages site in the server's `.env`, then restart:

   ```
   CORS_ORIGINS=https://homework.example.com
   ```

4. Push to the default branch (or run **Deploy web app to GitHub Pages** from the Actions page).

The workflow is `.github/workflows/pages.yml`. To build the web app locally against another server:

```bash
API_ORIGIN=https://api.example.com pnpm build
```

## Development

The server is Rust (axum + sqlx + Postgres) and the web app is TypeScript (adapted chat-demo). Requires Rust 1.85+, Node.js 22.12+ and pnpm 10.

Run only the database in Docker:

```bash
docker compose up -d db
```

Start the server (in `apps/server`; it reads `.env` from the repository root and listens on 8787):

```bash
cp .env.example .env
```

```bash
cd apps/server && cargo run
```

In another terminal, start the web dev server (http://localhost:8090, API proxied to 8787):

```bash
pnpm install && pnpm dev
```

Demo data:

```bash
cd apps/server && cargo run -- seed
```

Tests (need a Postgres; `sqlx::test` creates a temporary database per test):

```bash
cd apps/server && DATABASE_URL=postgres://homework:homework@localhost:5432/homework cargo test
```

Web type check and lint:

```bash
pnpm type && pnpm lint
```

```
apps/
  web/              # chat-demo (git subtree) + the homework pages in src/platform/
  server/           # Rust: REST API, AI gateway, database migrations, tests
packages/shared/    # shared types for the web app (match the server's JSON API)
deploy/             # deploying next to an existing gateway and Postgres
docs/design.md      # design document
Dockerfile          # web build + Rust build + slim runtime image
docker-compose.yml  # Postgres + app
```

The database schema is in `apps/server/migrations/` and is applied automatically on start.

Merging chat-demo updates from upstream:

```bash
git subtree pull --prefix apps/web https://github.com/deepseek-ai/chat-demo.git main --squash
```
