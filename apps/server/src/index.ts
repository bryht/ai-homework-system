import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app.js'
import { loadConfig, loadDotEnv } from './config.js'
import { openDatabase } from './db/client.js'
import { createRegistryFromConfig } from './gateway/providers.js'
import { createDiskStorage } from './storage.js'

loadDotEnv()
const config = loadConfig()
const { db, close } = await openDatabase({
  databaseUrl: config.databaseUrl,
  dataDir: config.dataDir ? path.join(config.dataDir, 'pglite') : null,
})
const providers = createRegistryFromConfig(config)
const app = createApp({
  db,
  config,
  storage: createDiskStorage(path.join(config.dataDir ?? '.data', 'uploads')),
  providers,
  now: () => new Date(),
})

// 生产环境由后端直接托管前端构建产物，前后端同源，Cookie 登录最简单
if (existsSync(config.webDist)) {
  const indexHtml = readFileSync(path.join(config.webDist, 'index.html'), 'utf8')
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), config.webDist) }))
  app.get('*', (c) => c.html(indexHtml))
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  const models = providers.models().map((m) => m.id).join(', ') || '(none)'
  console.log(`AI Homework server listening on http://localhost:${info.port}`)
  console.log(`  database: ${config.databaseUrl ? 'Postgres (DATABASE_URL)' : `PGlite at ${config.dataDir}`}`)
  console.log(`  models:   ${models}`)
})

const shutdown = () => {
  server.close()
  void close().finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
