import { createHash, randomBytes } from 'node:crypto'
import type { Role, User } from '@hw/shared'
import { eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from './context.js'
import { sessions, users } from './db/schema.js'
import { forbidden, unauthorized } from './lib/errors.js'

export const SESSION_COOKIE = 'hw_session'

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export const toUser = (row: typeof users.$inferSelect): User => ({
  id: row.id,
  role: row.role,
  name: row.name,
  username: row.username,
})

export const startSession = async (c: Context<AppEnv>, userId: string) => {
  const { db, config, now } = c.var.deps
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now().getTime() + config.sessionDays * 86_400_000)
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt })
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.cookieSecure,
    path: '/',
    expires: expiresAt,
  })
}

export const endSession = async (c: Context<AppEnv>) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    await c.var.deps.db.delete(sessions).where(eq(sessions.id, hashToken(token)))
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/** 读取 Cookie 对应的用户，放进 c.var.user；未登录时为 null */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null)
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    const { db, now } = c.var.deps
    const [row] = await db
      .select({ user: users, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, hashToken(token)))
    if (row && row.expiresAt > now()) {
      c.set('user', toUser(row.user))
    }
  }
  await next()
}

export const requireUser = (c: Context<AppEnv>): User => {
  const user = c.var.user
  if (!user) {
    throw unauthorized()
  }
  return user
}

export const requireRole = (c: Context<AppEnv>, role: Role): User => {
  const user = requireUser(c)
  if (user.role !== role) {
    throw forbidden()
  }
  return user
}

/** 简单的登录限流：同一 IP + 用户名 10 分钟内最多 10 次失败 */
const attempts = new Map<string, { count: number; resetAt: number }>()

export const loginLimiter = {
  blocked(key: string, now: number) {
    const entry = attempts.get(key)
    return entry !== undefined && entry.resetAt > now && entry.count >= 10
  },
  fail(key: string, now: number) {
    const entry = attempts.get(key)
    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + 10 * 60_000 })
    } else {
      entry.count += 1
    }
  },
  reset(key: string) {
    attempts.delete(key)
  },
}
