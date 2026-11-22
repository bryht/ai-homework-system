import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { loadHomeworkForTeacher } from '../access.js'
import { requireUser } from '../auth.js'
import type { AppEnv } from '../context.js'
import { files } from '../db/schema.js'
import { notFound } from '../lib/errors.js'

/** 只有上传者本人和该作业的老师可以下载 */
export const fileRoutes = new Hono<AppEnv>().get('/:id', async (c) => {
  const user = requireUser(c)
  const { db, storage } = c.var.deps
  const [row] = await db.select().from(files).where(eq(files.id, c.req.param('id')))
  if (!row) {
    throw notFound('文件不存在', 'File not found')
  }
  if (row.ownerId !== user.id) {
    if (!row.homeworkId || user.role !== 'teacher') {
      throw notFound('文件不存在', 'File not found')
    }
    await loadHomeworkForTeacher(db, row.homeworkId, user)
  }
  const data = await storage.get(row.storageKey)
  const inline = c.req.query('download') === undefined && /^(image\/|application\/pdf|text\/plain)/.test(row.mimeType)
  c.header('Content-Type', row.mimeType)
  c.header('Content-Length', String(data.byteLength))
  c.header(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`
  )
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
  return c.body(new Uint8Array(data))
})
