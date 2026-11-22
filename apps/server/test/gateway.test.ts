import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { turns } from '../src/db/schema.js'
import { DAY, chat, createTestContext, type TestContext } from './helpers.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestContext()
})

afterEach(async () => {
  await ctx.close()
})

const allTurns = () => ctx.db.select().from(turns).orderBy(turns.createdAt)

describe('POST /anthropic/v1/messages', () => {
  it('streams the reply and records the turn', async () => {
    const { student1, homeworkId, teacher, students } = await ctx.setupClass()
    const res = await chat(ctx, student1, homeworkId, { text: '一元二次方程怎么解？' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: message_stop')

    const [turn] = await allTurns()
    expect(turn).toMatchObject({ status: 'ok', kind: 'new', model: 'mock', stopReason: 'end_turn' })
    expect(turn!.userContent).toEqual([{ type: 'text', text: '一元二次方程怎么解？' }])
    const reply = turn!.assistantContent.find((b) => b.type === 'text')
    expect(String(reply?.text)).toContain('模拟回复')
    expect(turn!.outputTokens).toBeGreaterThan(0)

    // 老师在总览和详情里都能看到
    const overview = await (await ctx.request('GET', `/api/homeworks/${homeworkId}/overview`, { cookie: teacher })).json() as any
    expect(overview.students[0]).toMatchObject({ turns: 1, conversations: 1, activeDays: 1 })
    const record = await (
      await ctx.request('GET', `/api/homeworks/${homeworkId}/students/${students[0]!.id}`, { cookie: teacher })
    ).json() as any
    expect(record.conversations[0].title).toBe('一元二次方程怎么解？')
    expect(record.conversations[0].turns[0].userContent[0].text).toBe('一元二次方程怎么解？')
  })

  it('enforces the teacher configuration on the upstream request', async () => {
    const { student1, homeworkId } = await ctx.setupClass({ allowWebSearch: false, allowThinking: false })
    await (await chat(ctx, student1, homeworkId)).text()
    const [body] = ctx.spy.calls
    expect(body!.model).toBe('mock')
    expect(String(body!.system)).toContain('不要直接给出作业的最终答案')
    expect(String(body!.system)).toContain('完成课本第 3 章习题 1-5')
    expect(String(body!.system)).not.toContain('DeepSeek')
    expect(body!.tools).toBeUndefined()
    expect(body!.thinking).toEqual({ type: 'disabled' })
  })

  it('keeps tools when web search is allowed', async () => {
    const { student1, homeworkId } = await ctx.setupClass({ allowWebSearch: true })
    await (await chat(ctx, student1, homeworkId)).text()
    expect(ctx.spy.calls[0]!.tools).toHaveLength(2)
    expect(ctx.spy.calls[0]!.thinking).toEqual({ type: 'enabled' })
  })

  it('blocks chat outside the homework window', async () => {
    const { student1, homeworkId, teacher } = await ctx.setupClass()
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 20 * DAY)
    const closed = await chat(ctx, student1, homeworkId)
    expect(closed.status).toBe(403)
    expect((await closed.json() as any).error.message).toBe('作业已截止，不能再使用 AI')

    ctx.clock.now = new Date(ctx.clock.now.getTime() - 30 * DAY)
    expect((await chat(ctx, student1, homeworkId)).status).toBe(403)

    // 老师预览不受时间限制，也不计入学生统计
    expect((await chat(ctx, teacher, homeworkId)).status).toBe(200)
  })

  it('stops a student once the token budget is used up', async () => {
    const { student1, student2, homeworkId } = await ctx.setupClass({ tokenBudget: 10 })
    await (await chat(ctx, student1, homeworkId)).text()
    const res = await chat(ctx, student1, homeworkId)
    expect(res.status).toBe(403)
    expect((await res.json() as any).error.message).toContain('额度已用完')
    // 额度按学生分别计算
    expect((await chat(ctx, student2, homeworkId)).status).toBe(200)
  })

  it('rejects students from other classes', async () => {
    const { homeworkId } = await ctx.setupClass()
    const otherTeacher = await ctx.createTeacher('teacher2')
    const klass = await (await ctx.request('POST', '/api/classes', { cookie: otherTeacher, json: { name: 'B' } })).json() as any
    const created = await (
      await ctx.request('POST', `/api/classes/${klass.class.id}/students`, {
        cookie: otherTeacher,
        json: { students: [{ name: 'Bob', username: 'bob' }] },
      })
    ).json() as any
    const bob = await ctx.login('bob', created.credentials[0].password)
    expect((await chat(ctx, bob, homeworkId)).status).toBe(404)
    expect((await chat(ctx, '', homeworkId)).status).toBe(401)
  })

  it('infers regenerate, edit and continue turns from chat-demo message IDs', async () => {
    const { student1, homeworkId } = await ctx.setupClass()
    await (await chat(ctx, student1, homeworkId, { userMessageId: 'u1' })).text()
    await (await chat(ctx, student1, homeworkId, { userMessageId: 'u1' })).text()
    await (await chat(ctx, student1, homeworkId, { userMessageId: 'u1-edited' })).text()
    await (
      await chat(ctx, student1, homeworkId, {
        userMessageId: 'u1',
        messages: [
          { role: 'user', content: '这道题怎么做？' },
          { role: 'assistant', content: [{ type: 'text', text: '先' }] },
        ],
      })
    ).text()
    await (await chat(ctx, student1, homeworkId, { userMessageId: 'u2', parentMessageId: 'a1' })).text()
    expect((await allTurns()).map((t) => t.kind)).toEqual(['new', 'regenerate', 'edit', 'continue', 'new'])
  })

  it('records a turn as aborted when the student stops generating', async () => {
    const { student1, homeworkId } = await ctx.setupClass()
    const res = await chat(ctx, student1, homeworkId)
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    const [turn] = await allTurns()
    expect(turn!.status).toBe('aborted')
  })

  it('maps uploaded files to provider file IDs and keeps the original', async () => {
    const { student1, student2, homeworkId, teacher, students } = await ctx.setupClass()
    const form = new FormData()
    form.append('purpose', 'user_data')
    form.append('file', new File(['x^2 = 4'], 'notes.txt', { type: 'text/plain' }))
    const upload = await ctx.app.request('/anthropic/v1/files', {
      method: 'POST',
      headers: { cookie: student1, 'x-hw-homework-id': homeworkId },
      body: form,
    })
    expect(upload.status).toBe(200)
    const file = (await upload.json() as any) as { id: string; filename: string }
    expect(file.id).toMatch(/^file_/)
    expect(ctx.spy.uploads).toEqual(['notes.txt'])

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', file_id: file.id } },
          { type: 'text', text: '帮我看看' },
        ],
      },
    ]
    await (await chat(ctx, student1, homeworkId, { messages })).text()
    const sent = ctx.spy.calls[0]!.messages as { content: { source?: { file_id: string } }[] }[]
    expect(sent[0]!.content[0]!.source!.file_id).toBe('mockfile_1')

    const record = await (
      await ctx.request('GET', `/api/homeworks/${homeworkId}/students/${students[0]!.id}`, { cookie: teacher })
    ).json() as any
    expect(record.conversations[0].turns[0].files[0].filename).toBe('notes.txt')

    // 其他学生不能引用这个文件
    const res = await chat(ctx, student2, homeworkId, { messages })
    expect(res.status).toBe(400)
  })

  it('rejects uploads when the homework disables them', async () => {
    const { student1, homeworkId } = await ctx.setupClass({ allowFileUpload: false })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
    const res = await ctx.app.request('/anthropic/v1/files', {
      method: 'POST',
      headers: { cookie: student1, 'x-hw-homework-id': homeworkId },
      body: form,
    })
    expect(res.status).toBe(403)
  })

  it('passes upstream errors through and records them', async () => {
    const { student1, homeworkId } = await ctx.setupClass()
    ctx.spy.provider.createMessage = async () =>
      new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    const res = await chat(ctx, student1, homeworkId)
    expect(res.status).toBe(429)
    expect((await res.json() as any).error.message).toBe('slow down')
    const [turn] = await ctx.db.select().from(turns).where(eq(turns.homeworkId, homeworkId))
    expect(turn).toMatchObject({ status: 'error' })
    expect(turn!.error).toContain('429')
  })

  it('disables voice endpoints', async () => {
    const { student1 } = await ctx.setupClass()
    const res = await ctx.request('POST', '/v1/tools/asr', { cookie: student1 })
    expect(res.status).toBe(403)
  })
})
