import type { Context } from 'hono'
import type { z } from 'zod'
import { badRequest } from './errors.js'

export const parseJson = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw badRequest('请求格式错误', 'Invalid JSON body')
  }
  const result = schema.safeParse(body)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path.join('.') || 'body'
    throw badRequest(`参数错误：${where}`, `Invalid field: ${where}`)
  }
  return result.data
}
