# AI Homework System

老师布置作业，学生在作业期间使用系统内置的 AI 完成作业。系统记录学生使用 AI 的全过程（提问、上传的文件、AI 的回答），老师据此查看过程、评估作业。

- 设计文档：[docs/design.md](docs/design.md)
- 前端基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）改写

| 学生：作业聊天 | 老师：完成情况 | 老师：对话回放 |
| --- | --- | --- |
| ![](docs/screenshots/student-chat.png) | ![](docs/screenshots/teacher-overview.png) | ![](docs/screenshots/teacher-transcript.png) |

## 功能（第一期）

**老师**
- 创建班级，批量创建学生账号（初始密码只显示一次，可下载 CSV），重置密码
- 布置作业：开始/截止时间、作业要求（Markdown）、草稿/发布、是否允许迟交
- 按作业配置 AI：模型、教学模式（引导式 / 讲解式 / 开放式 / 自定义提示词）、联网搜索、文件上传、深度思考、每个学生的 Token 额度
- 试用 AI：用学生看到的界面预览作业配置
- 完成情况：每个学生的提问数、Token、活跃天数、最近使用、提交状态
- 学生详情：按时间回放全部对话（包括重新生成、编辑重发、中途停止的记录），查看附件、提交内容，打分和写评语，导出 CSV

**学生**
- 作业列表（进行中 / 未开始 / 已截止，剩余时间，提交状态）
- 作业聊天：chat-demo 原有的体验（流式回答、深度思考、Markdown、公式、代码、上传文件），顶部显示作业要求、截止时间和「对话会被老师查看」的提示
- 提交作业：文字 + 附件 + 诚信声明，截止前可以修改

**后端网关**
- 学生的浏览器只和我们的后端通信，拿不到模型的 API Key
- 每次请求都按作业配置改写：老师的教学提示词放在系统提示词最前面，学生无法覆盖；按开关去掉联网搜索、深度思考；检查时间窗口和额度
- 原样流式转发给浏览器，同时把本轮问题、完整回答、用量、耗时存档；上传的文件保留原件

## 用 Docker Compose 运行（推荐）

需要 Docker（含 Compose）。在仓库根目录：

```bash
docker compose up -d --build
```

```bash
docker compose exec app ai-homework seed
```

打开 http://localhost:8787 ，用演示账号登录（密码都是 `demo1234`）：

| 账号 | 角色 |
| --- | --- |
| `teacher` | 老师（Ms. Taylor，「Pilot Class」） |
| `student1` / `student2` / `student3` | 学生 |

界面默认英文，登录页和「账号」页可以切换中文。

没有配置 `DEEPSEEK_API_KEY` 时，作业使用**模拟模型**：不调用任何外部服务，回复里会显示网关注入的教学提示词，方便检查配置。要用 DeepSeek：

```bash
cp .env.example .env
```

在 `.env` 里填上 `DEEPSEEK_API_KEY`，然后重新启动：

```bash
docker compose up -d
```

数据存在两个 Docker volume 里：`db-data`（Postgres）和 `uploads`（上传的文件）。完全重置：

```bash
docker compose down -v
```

创建正式的老师账号（不传 `--password` 会随机生成并打印）：

```bash
docker compose exec app ai-homework create-teacher --username wang --name "Mr. Wang"
```

放到公网时，前面加一层 HTTPS（例如 Caddy），并在 `.env` 里设置 `COOKIE_SECURE=true`。

## 开发

后端是 Rust（axum + sqlx + Postgres），前端是 TypeScript（chat-demo 改写）。需要 Rust 1.85+、Node.js 22.12+、pnpm 10。

只用 Docker 跑数据库：

```bash
docker compose up -d db
```

启动后端（在 `apps/server`，读取仓库根目录的 `.env`，监听 8787）：

```bash
cp .env.example .env
```

```bash
cd apps/server && cargo run
```

另开一个终端启动前端开发服务器（http://localhost:8090 ，接口代理到 8787）：

```bash
pnpm install && pnpm dev
```

演示数据：

```bash
cd apps/server && cargo run -- seed
```

测试（需要一个 Postgres，`sqlx::test` 会为每个测试建一个临时数据库）：

```bash
cd apps/server && DATABASE_URL=postgres://homework:homework@localhost:5432/homework cargo test
```

前端类型检查和 lint：

```bash
pnpm type && pnpm lint
```

```
apps/
  web/              # chat-demo（git subtree）+ src/platform/ 下的作业系统页面
  server/           # Rust：REST API、AI 网关、数据库迁移、测试
packages/shared/    # 前端用的共享类型（和后端 JSON 接口一一对应）
docs/design.md      # 设计文档
Dockerfile          # 前端构建 + Rust 编译 + 精简运行镜像
docker-compose.yml  # Postgres + app
```

数据库表结构在 `apps/server/migrations/`，服务启动时自动执行。

合并 chat-demo 上游更新：

```bash
git subtree pull --prefix apps/web https://github.com/deepseek-ai/chat-demo.git main --squash
```
