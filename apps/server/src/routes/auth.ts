import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { endSession, loginLimiter, requireUser, startSession, toUser } from '../auth.js'
import type { AppEnv } from '../context.js'
import { users } from '../db/schema.js'
import { HttpError, badRequest } from '../lib/errors.js'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { parseJson } from '../lib/validate.js'

const loginBody = z.object({ username: z.string().trim().min(1), password: z.string().min(1) })
const passwordBody = z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(200) })

export const authRoutes = new Hono<AppEnv>()
  .post('/login', async (c) => {
    const { username, password } = await parseJson(c, loginBody)
    const key = `${c.req.header('x-forwarded-for') ?? ''}:${username.toLowerCase()}`
    const now = Date.now()
    if (loginLimiter.blocked(key, now)) {
      throw new HttpError(429, {
        zh: '尝试次数过多，请 10 分钟后再试',
        en: 'Too many attempts. Try again in 10 minutes.',
      })
    }
    const [row] = await c.var.deps.db
      .select()
      .from(users)
      .where(eq(users.username, username.toLowerCase()))
    if (!row || !(await verifyPassword(password, row.passwordHash))) {
      loginLimiter.fail(key, now)
      throw new HttpError(401, { zh: '用户名或密码错误', en: 'Wrong username or password' }, 'authentication_error')
    }
    loginLimiter.reset(key)
    await startSession(c, row.id)
    return c.json({ user: toUser(row) })
  })
  .post('/logout', async (c) => {
    await endSession(c)
    return c.json({ ok: true })
  })
  .get('/me', (c) => c.json({ user: c.var.user }))
  .post('/password', async (c) => {
    const user = requireUser(c)
    const body = await parseJson(c, passwordBody)
    const { db } = c.var.deps
    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    if (!row || !(await verifyPassword(body.currentPassword, row.passwordHash))) {
      throw badRequest('当前密码不正确', 'Current password is incorrect')
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword) })
      .where(eq(users.id, user.id))
    return c.json({ ok: true })
  })
