import type { ClassInfo, ClassStudent, CreatedCredential } from '@hw/shared'
import { and, asc, count, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import type { AppEnv } from '../context.js'
import type { Db } from '../db/client.js'
import { classMembers, classes, users } from '../db/schema.js'
import { badRequest, notFound } from '../lib/errors.js'
import { newId, newPassword } from '../lib/ids.js'
import { hashPassword } from '../lib/password.js'
import { parseJson } from '../lib/validate.js'

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/

const classBody = z.object({ name: z.string().trim().min(1).max(100) })
const studentsBody = z.object({
  students: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        username: z.string().trim().toLowerCase().optional(),
      })
    )
    .min(1)
    .max(200),
})

const loadOwnClass = async (c: Context<AppEnv>) => {
  const teacher = requireRole(c, 'teacher')
  const [row] = await c.var.deps.db
    .select()
    .from(classes)
    .where(and(eq(classes.id, c.req.param('classId') ?? ''), eq(classes.teacherId, teacher.id)))
  if (!row) {
    throw notFound('班级不存在', 'Class not found')
  }
  return row
}

/** 英文名转成 alice.wang；中文名等无法转换的用 s + 随机数字 */
const suggestUsername = (name: string) => {
  const ascii = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
  return USERNAME.test(ascii) ? ascii : `s${Math.floor(10000 + Math.random() * 90000)}`
}

const uniqueUsername = async (db: Db, base: string, taken: Set<string>) => {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}${i + 1}`
    if (taken.has(candidate)) {
      continue
    }
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate))
    if (!existing) {
      return candidate
    }
  }
  return `${base}${Date.now() % 100000}`
}

export const classRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const teacher = requireRole(c, 'teacher')
    const rows = await c.var.deps.db
      .select({ klass: classes, studentCount: count(classMembers.studentId) })
      .from(classes)
      .leftJoin(classMembers, eq(classMembers.classId, classes.id))
      .where(eq(classes.teacherId, teacher.id))
      .groupBy(classes.id)
      .orderBy(asc(classes.createdAt))
    const result: ClassInfo[] = rows.map(({ klass, studentCount }) => ({
      id: klass.id,
      name: klass.name,
      studentCount,
      createdAt: klass.createdAt.toISOString(),
    }))
    return c.json({ classes: result })
  })
  .post('/', async (c) => {
    const teacher = requireRole(c, 'teacher')
    const { name } = await parseJson(c, classBody)
    const id = newId('cls')
    await c.var.deps.db.insert(classes).values({ id, teacherId: teacher.id, name })
    return c.json({ class: { id, name, studentCount: 0, createdAt: new Date().toISOString() } })
  })
  .patch('/:classId', async (c) => {
    const klass = await loadOwnClass(c)
    const { name } = await parseJson(c, classBody)
    await c.var.deps.db.update(classes).set({ name }).where(eq(classes.id, klass.id))
    return c.json({ ok: true })
  })
  .get('/:classId/students', async (c) => {
    const klass = await loadOwnClass(c)
    const rows = await c.var.deps.db
      .select({ id: users.id, name: users.name, username: users.username })
      .from(classMembers)
      .innerJoin(users, eq(users.id, classMembers.studentId))
      .where(eq(classMembers.classId, klass.id))
      .orderBy(asc(classMembers.createdAt))
    const students: ClassStudent[] = rows
    return c.json({ students })
  })
  .post('/:classId/students', async (c) => {
    const klass = await loadOwnClass(c)
    const body = await parseJson(c, studentsBody)
    const { db } = c.var.deps
    const created: CreatedCredential[] = []
    const taken = new Set<string>()
    for (const entry of body.students) {
      if (entry.username && !USERNAME.test(entry.username)) {
        throw badRequest(
          `用户名「${entry.username}」只能包含小写字母、数字、点、下划线和连字符（2–32 位）`,
          `Username "${entry.username}" may only contain a-z, 0-9, ".", "_" and "-" (2-32 chars)`
        )
      }
      if (entry.username) {
        const [existing] = await db.select().from(users).where(eq(users.username, entry.username))
        if (existing) {
          if (existing.role !== 'student') {
            throw badRequest(`用户名「${entry.username}」已被占用`, `Username "${entry.username}" is taken`)
          }
          await db.insert(classMembers).values({ classId: klass.id, studentId: existing.id }).onConflictDoNothing()
          created.push({ id: existing.id, name: existing.name, username: existing.username, password: null })
          taken.add(existing.username)
          continue
        }
      }
      const username = entry.username ?? (await uniqueUsername(db, suggestUsername(entry.name), taken))
      taken.add(username)
      const password = newPassword()
      const id = newId('usr')
      await db.insert(users).values({
        id,
        role: 'student',
        name: entry.name,
        username,
        passwordHash: await hashPassword(password),
      })
      await db.insert(classMembers).values({ classId: klass.id, studentId: id })
      created.push({ id, name: entry.name, username, password })
    }
    return c.json({ credentials: created })
  })
  .post('/:classId/students/:studentId/reset-password', async (c) => {
    const klass = await loadOwnClass(c)
    const studentId = c.req.param('studentId')
    const { db } = c.var.deps
    const [member] = await db
      .select({ user: users })
      .from(classMembers)
      .innerJoin(users, eq(users.id, classMembers.studentId))
      .where(and(eq(classMembers.classId, klass.id), eq(classMembers.studentId, studentId)))
    if (!member) {
      throw notFound('学生不在这个班级', 'Student is not in this class')
    }
    const password = newPassword()
    await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, studentId))
    const credential: CreatedCredential = {
      id: member.user.id,
      name: member.user.name,
      username: member.user.username,
      password,
    }
    return c.json({ credential })
  })
  .delete('/:classId/students/:studentId', async (c) => {
    const klass = await loadOwnClass(c)
    await c.var.deps.db
      .delete(classMembers)
      .where(and(eq(classMembers.classId, klass.id), eq(classMembers.studentId, c.req.param('studentId'))))
    return c.json({ ok: true })
  })
