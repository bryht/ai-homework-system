# 部署到已有的服务器（BANWAGONG）

适用于服务器上**已经有反向代理（nginx / Caddy 等）和 Postgres**、还跑着其他系统的情况：只新增一个后端容器，复用已有的网关和数据库。

```
浏览器（GitHub Pages 上的前端）
        │ HTTPS
        ▼
已有网关（nginx / Caddy）──► 新增：ai-homework 容器（127.0.0.1:8787）
                                    │
                                    ▼
                         已有 Postgres 里新建的 ai_homework 数据库
```

## 1. 镜像

推送到 `main` 后，GitHub Actions（`.github/workflows/image.yml`）会构建镜像并发布到 `ghcr.io/bryht/ai-homework-system:latest`。服务器只拉镜像，不在小内存的 VPS 上编译 Rust。

第一次构建完成后，到 GitHub 的 **Packages → ai-homework-system → Package settings** 把可见性改成 Public；或者在服务器上用有 `read:packages` 权限的令牌执行 `docker login ghcr.io`。

## 2. 数据库

在已有的 Postgres 里建一个独立的用户和数据库（先改掉密码）：

```bash
sudo -u postgres psql -f postgres-setup.sql
```

Postgres 如果直接装在主机上（不在 Docker 里），还要让它接受 Docker 网桥的连接，见 `postgres-setup.sql` 末尾的注释。表结构由应用启动时自动创建，不会动其他系统的数据库。

## 3. 后端

把这个目录复制到服务器，例如 `/opt/ai-homework/`：

```bash
cp env.example .env
```

填好 `.env` 里的 `DATABASE_URL`、`DEEPSEEK_API_KEY`、`CORS_ORIGINS`，然后：

```bash
docker compose pull && docker compose up -d
```

```bash
docker compose exec app ai-homework create-teacher --username wang --name "Mr. Wang"
```

容器只监听 `127.0.0.1:8787`，外网访问必须经过网关。

## 4. 网关

在已有的网关里加一条转发，二选一：

- **子域名**（推荐）：`homework-api.example.com` → `127.0.0.1:8787`
- **已有域名下的路径**：`https://example.com/homework/` → `127.0.0.1:8787`（去掉 `/homework` 前缀）

nginx 和 Caddy 的写法见 `nginx.conf.example`、`Caddyfile.example`。必须关掉响应缓冲（AI 回复是流式的），并把上传上限放到 32 MB。

## 5. 前端

GitHub 仓库变量 `API_ORIGIN` 设为上一步的地址（`https://homework-api.example.com` 或 `https://example.com/homework`），然后运行 Pages 工作流。

## 更新

```bash
docker compose pull && docker compose up -d
```

## 备份

数据库按其他系统的方式备份 `ai_homework` 库即可；上传的文件在 Docker volume `uploads` 里：

```bash
docker run --rm -v ai-homework_uploads:/data -v "$PWD":/backup debian tar czf /backup/uploads.tgz -C /data .
```
