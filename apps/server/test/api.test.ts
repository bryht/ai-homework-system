import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DAY, createTestContext, type TestContext } from './helpers.js'

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestContext()
})

afterEach(async () => {
  await ctx.close()
})

describe('auth', () => {
  it('logs in, reports the current user and logs out', async () => {
    const cookie = await ctx.createTeacher()
    const me = await (await ctx.request('GET', '/api/auth/me', { cookie })).json() as any
    expect(me.user).toMatchObject({ username: 'teacher', role: 'teacher' })

    await ctx.request('POST', '/api/auth/logout', { cookie })
    const after = await (await ctx.request('GET', '/api/auth/me', { cookie })).json() as any
    expect(after.user).toBeNull()
  })

  it('rejects a wrong password with a localized message', async () => {
    await ctx.createTeacher()
    const res = await ctx.request('POST', '/api/auth/login', {
      json: { username: 'teacher', password: 'nope' },
      headers: { 'accept-language': 'en-US' },
    })
    expect(res.status).toBe(401)
    expect((await res.json() as any).error.message).toBe('Wrong username or password')
  })

  it('rejects cross-site writes', async () => {
    const cookie = await ctx.createTeacher()
    const res = await ctx.request('POST', '/api/classes', {
      cookie,
      json: { name: 'x' },
      headers: { origin: 'https://evil.example', host: 'school.example' },
    })
    expect(res.status).toBe(403)
  })

  it('lets a user change their password', async () => {
    const cookie = await ctx.createTeacher()
    const res = await ctx.request('POST', '/api/auth/password', {
      cookie,
      json: { currentPassword: 'teacher-pass', newPassword: 'a-new-password' },
    })
    expect(res.status).toBe(200)
    await expect(ctx.login('teacher', 'a-new-password')).resolves.toContain('hw_session=')
  })
})

describe('classes and students', () => {
  it('creates student accounts with one-time passwords', async () => {
    const { classId, teacher, students } = await ctx.setupClass()
    expect(students[0]).toMatchObject({ username: 'zhangsan' })
    expect(students[1]).toMatchObject({ username: 'alice.wang' })
    expect(students[0]!.password).toHaveLength(10)

    const list = await (await ctx.request('GET', `/api/classes/${classId}/students`, { cookie: teacher })).json() as any
    expect(list.students.map((s: { username: string }) => s.username)).toEqual(['zhangsan', 'alice.wang'])

    const reset = await (
      await ctx.request('POST', `/api/classes/${classId}/students/${students[0]!.id}/reset-password`, { cookie: teacher })
    ).json() as any
    await expect(ctx.login('zhangsan', reset.credential.password)).resolves.toContain('hw_session=')
  })

  it('does not let students manage classes', async () => {
    const { student1 } = await ctx.setupClass()
    const res = await ctx.request('POST', '/api/classes', { cookie: student1, json: { name: 'x' } })
    expect(res.status).toBe(403)
  })
})

describe('homeworks', () => {
  it('shows students a safe view without the teaching prompt', async () => {
    const { student1, homeworkId } = await ctx.setupClass()
    const res = await (await ctx.request('GET', `/api/homeworks/${homeworkId}`, { cookie: student1 })).json() as any
    expect(res.homework.phase).toBe('open')
    expect(res.homework.aiConfig).toBeUndefined()
    expect(res.homework.ai).toEqual({ allowWebSearch: false, allowFileUpload: true, allowThinking: true })
    expect(JSON.stringify(res)).not.toContain('引导')
  })

  it('hides drafts and other classes from students', async () => {
    const { teacher, classId, student1, homeworkId } = await ctx.setupClass()
    await ctx.request('PATCH', `/api/homeworks/${homeworkId}`, { cookie: teacher, json: { status: 'draft' } })
    expect((await ctx.request('GET', `/api/homeworks/${homeworkId}`, { cookie: student1 })).status).toBe(404)
    const list = await (await ctx.request('GET', '/api/homeworks', { cookie: student1 })).json() as any
    expect(list.homeworks).toHaveLength(0)

    // 另一位老师看不到这个班级的作业
    const other = await ctx.createTeacher('teacher2')
    expect((await ctx.request('GET', `/api/homeworks/${homeworkId}`, { cookie: other })).status).toBe(404)
    expect((await ctx.request('GET', `/api/classes/${classId}/students`, { cookie: other })).status).toBe(404)
  })

  it('validates the time window and model', async () => {
    const { teacher, homeworkId } = await ctx.setupClass()
    const bad = await ctx.request('PATCH', `/api/homeworks/${homeworkId}`, {
      cookie: teacher,
      json: { dueAt: '2020-01-01T00:00:00Z' },
    })
    expect(bad.status).toBe(400)
    const badModel = await ctx.request('PATCH', `/api/homeworks/${homeworkId}`, {
      cookie: teacher,
      json: {
        aiConfig: {
          model: 'gpt-x',
          teachingMode: 'open',
          systemPrompt: '',
          allowWebSearch: false,
          allowFileUpload: false,
          allowThinking: false,
          tokenBudget: null,
        },
      },
    })
    expect(badModel.status).toBe(400)
  })
})

describe('submissions and grading', () => {
  it('accepts submissions during the window and rejects them after the due date', async () => {
    const { student1, homeworkId } = await ctx.setupClass()
    const ok = await ctx.request('PUT', `/api/homeworks/${homeworkId}/submission`, {
      cookie: student1,
      json: { content: '我的答案：x = 2' },
    })
    expect(ok.status).toBe(200)
    expect((await ok.json() as any).submission).toMatchObject({ content: '我的答案：x = 2', isLate: false })

    ctx.clock.now = new Date(ctx.clock.now.getTime() + 20 * DAY)
    const late = await ctx.request('PUT', `/api/homeworks/${homeworkId}/submission`, {
      cookie: student1,
      json: { content: '改一下' },
    })
    expect(late.status).toBe(403)
  })

  it('flags late submissions when they are allowed', async () => {
    const { teacher, student1, homeworkId } = await ctx.setupClass()
    await ctx.request('PATCH', `/api/homeworks/${homeworkId}`, { cookie: teacher, json: { allowLateSubmission: true } })
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 20 * DAY)
    const res = await ctx.request('PUT', `/api/homeworks/${homeworkId}/submission`, {
      cookie: student1,
      json: { content: 'late' },
    })
    expect((await res.json() as any).submission.isLate).toBe(true)
  })

  it('attaches uploaded files and lets the teacher download them', async () => {
    const { teacher, student1, student2, homeworkId, students } = await ctx.setupClass()
    const form = new FormData()
    form.append('file', new File(['hello'], '作业.txt', { type: 'text/plain' }))
    const upload = await (
      await ctx.request('POST', `/api/homeworks/${homeworkId}/submission/files`, { cookie: student1, body: form })
    ).json() as any
    const fileId = upload.file.id as string

    // 别人的文件不能挂到自己的提交上
    const stolen = await ctx.request('PUT', `/api/homeworks/${homeworkId}/submission`, {
      cookie: student2,
      json: { content: 'x', fileIds: [fileId] },
    })
    expect(stolen.status).toBe(400)

    await ctx.request('PUT', `/api/homeworks/${homeworkId}/submission`, {
      cookie: student1,
      json: { content: '见附件', fileIds: [fileId] },
    })
    const record = await (
      await ctx.request('GET', `/api/homeworks/${homeworkId}/students/${students[0]!.id}`, { cookie: teacher })
    ).json() as any
    expect(record.submission.files[0].filename).toBe('作业.txt')

    const download = await ctx.request('GET', `/api/files/${fileId}`, { cookie: teacher })
    expect(await download.text()).toBe('hello')
    expect((await ctx.request('GET', `/api/files/${fileId}`, { cookie: student2 })).status).toBe(404)
  })

  it('stores grades and exports CSV', async () => {
    const { teacher, homeworkId, students } = await ctx.setupClass()
    const res = await ctx.request('PUT', `/api/homeworks/${homeworkId}/students/${students[0]!.id}/grade`, {
      cookie: teacher,
      json: { score: 92, comment: '思路清晰, "好"' },
    })
    expect((await res.json() as any).grade).toMatchObject({ score: 92 })
    const csv = await (await ctx.request('GET', `/api/homeworks/${homeworkId}/export.csv`, { cookie: teacher })).text()
    expect(csv).toContain('zhangsan,张三,0,0,0,,,92,"思路清晰, ""好"""')
  })
})
