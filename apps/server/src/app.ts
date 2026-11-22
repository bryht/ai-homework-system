import { Hono } from 'hono'
import { requireUser, sessionMiddleware } from './auth.js'
import type { AppEnv, Deps } from './context.js'
import { gatewayRoutes } from './gateway/index.js'
import { HttpError, forbidden, pickLang } from './lib/errors.js'
import { authRoutes } from './routes/auth.js'
import { classRoutes } from './routes/classes.js'
import { fileRoutes } from './routes/files.js'
import { homeworkRoutes } from './routes/homeworks.js'

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const createApp = (deps: Deps) => {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('deps', deps)
    await next()
  })

  // CSRF：写操作的 Origin 必须和 Host 一致（配合 SameSite=Lax 的会话 Cookie）
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    if (UNSAFE.has(c.req.method) && origin) {
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host')
      let originHost: string | null = null
      try {
        originHost = new URL(origin).host
      } catch {
        // 非法 Origin 按跨站处理
      }
      if (!host || originHost !== host) {
        throw forbidden('跨站请求被拒绝', 'Cross-site request rejected')
      }
    }
    await next()
  })

  app.use('/api/*', sessionMiddleware)
  app.use('/anthropic/*', sessionMiddleware)
  app.use('/v1/*', sessionMiddleware)

  app.route('/api/auth', authRoutes)
  app.route('/api/classes', classRoutes)
  app.route('/api/homeworks', homeworkRoutes)
  app.route('/api/files', fileRoutes)
  app.get('/api/models', (c) => {
    requireUser(c)
    return c.json({ models: deps.providers.models() })
  })
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/anthropic/v1', gatewayRoutes)
  // chat-demo 的语音识别和朗读接口，第一期不开放
  app.all('/v1/tools/*', () => {
    throw forbidden('语音功能暂未开放', 'Voice features are not available')
  })

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/anthropic/')) {
      return c.json({ error: { type: 'not_found_error', message: 'Not found' } }, 404)
    }
    return c.text('Not found', 404)
  })

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      const lang = pickLang(c.req.header('accept-language'))
      return c.json({ error: { type: error.type, message: error.text[lang] } }, error.status)
    }
    console.error(error)
    return c.json({ error: { type: 'api_error', message: 'Internal server error' } }, 500)
  })

  return app
}
