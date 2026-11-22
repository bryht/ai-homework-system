import { DEFAULT_AI_CONFIG, type AiConfig } from '@hw/shared'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { createMockProvider, createRegistry, type Provider } from '../src/gateway/providers.js'
import { newId } from '../src/lib/ids.js'
import { hashPassword } from '../src/lib/password.js'
import { createMemoryStorage } from '../src/storage.js'

export const DAY = 86_400_000

/** 记录发给供应商的请求体，方便断言网关的改写 */
export const createSpyProvider = () => {
  const inner = createMockProvider({ chunkDelayMs: 0 })
  const calls: Record<string, unknown>[] = []
  const uploads: string[] = []
  const provider: Provider = {
    ...inner,
    async createMessage(body, options) {
      calls.push(structuredClone(body))
      return inner.createMessage(body, options)
    },
    async uploadFile(file, signal) {
      uploads.push(file.filename)
      return inner.uploadFile(file, signal)
    },
  }
  return { provider, calls, uploads }
}

export const createTestContext = async () => {
  const { db, close } = await openDatabase({ dataDir: null })
  const spy = createSpyProvider()
  const clock = { now: new Date('2026-11-01T00:00:00Z') }
  const config = { ...loadConfig({}), dataDir: null, cookieSecure: false, sessionDays: 365 }
  const app = createApp({
    db,
    config,
    storage: createMemoryStorage(),
    providers: createRegistry([spy.provider]),
    now: () => new Date(clock.now),
  })

  const request = async (
    method: string,
    path: string,
    options: { cookie?: string; json?: unknown; body?: RequestInit['body']; headers?: Record<string, string> } = {}
  ) => {
    const headers: Record<string, string> = { ...options.headers }
    if (options.cookie) {
      headers.cookie = options.cookie
    }
    let body = options.body
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.json)
    }
    return app.request(path, { method, headers, body })
  }

  const login = async (username: string, password: string) => {
    const res = await request('POST', '/api/auth/login', { json: { username, password } })
    if (res.status !== 200) {
      throw new Error(`login failed: ${res.status} ${await res.text()}`)
    }
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    return cookie
  }

  const createTeacher = async (username = 'teacher') => {
    await db.insert(users).values({
      id: newId('usr'),
      role: 'teacher',
      name: 'Teacher',
      username,
      passwordHash: await hashPassword('teacher-pass'),
    })
    return login(username, 'teacher-pass')
  }

  /** 老师 + 班级 + 两名学生 + 一个已发布的作业（开放 14 天） */
  const setupClass = async (aiConfig: Partial<AiConfig> = {}) => {
    const teacher = await createTeacher()
    const klass = (await (await request('POST', '/api/classes', { cookie: teacher, json: { name: '七年级一班' } })).json()) as {
      class: { id: string }
    }
    const created = (await (
      await request('POST', `/api/classes/${klass.class.id}/students`, {
        cookie: teacher,
        json: { students: [{ name: '张三', username: 'zhangsan' }, { name: 'Alice Wang' }] },
      })
    ).json()) as { credentials: { id: string; username: string; password: string }[] }
    const [s1, s2] = created.credentials
    const hwRes = await request('POST', '/api/homeworks', {
      cookie: teacher,
      json: {
        classId: klass.class.id,
        title: '一元二次方程',
        description: '完成课本第 3 章习题 1-5',
        startAt: new Date(clock.now.getTime() - DAY).toISOString(),
        dueAt: new Date(clock.now.getTime() + 14 * DAY).toISOString(),
        status: 'published',
        allowLateSubmission: false,
        aiConfig: { ...DEFAULT_AI_CONFIG, model: 'mock', ...aiConfig },
      },
    })
    if (hwRes.status !== 200) {
      throw new Error(`create homework failed: ${hwRes.status} ${await hwRes.text()}`)
    }
    const hw = (await hwRes.json()) as { homework: { id: string } }
    return {
      teacher,
      classId: klass.class.id,
      homeworkId: hw.homework.id,
      students: [s1!, s2!],
      student1: await login(s1!.username, s1!.password),
      student2: await login(s2!.username, s2!.password),
    }
  }

  return { app, db, close, spy, clock, request, login, createTeacher, setupClass }
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>

/** 按 chat-demo 的方式调用网关 */
export const chat = (
  ctx: TestContext,
  cookie: string,
  homeworkId: string,
  options: {
    text?: string
    session?: string
    userMessageId?: string
    parentMessageId?: string
    messages?: unknown[]
    extra?: Record<string, unknown>
    signal?: AbortSignal
  } = {}
) => {
  const userMessageId = options.userMessageId ?? `u-${Math.random()}`
  const headers: Record<string, string> = {
    'x-hw-homework-id': homeworkId,
    'x-hw-conversation-id': options.session ?? 'session-1',
    'x-hw-user-message-id': userMessageId,
    'x-hw-assistant-message-id': `a-${Math.random()}`,
    cookie,
    'content-type': 'application/json',
  }
  if (options.parentMessageId) {
    headers['x-hw-parent-message-id'] = options.parentMessageId
  }
  return ctx.app.request('/anthropic/v1/messages', {
    method: 'POST',
    headers,
    signal: options.signal,
    body: JSON.stringify({
      model: 'deepseek-flash',
      system: '该助手为DeepSeek，由深度求索公司创造。',
      messages: options.messages ?? [{ role: 'user', content: options.text ?? '这道题怎么做？' }],
      thinking: { type: 'enabled' },
      tools: [
        { type: 'deepseek_read_url', name: 'deepseek_read_url' },
        { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      ],
      safety_check: { level: 'high' },
      title: { enabled: true },
      ...options.extra,
    }),
  })
}
