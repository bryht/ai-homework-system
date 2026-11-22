import type {
  Conversation,
  Grade,
  HomeworkOverview,
  StudentProgress,
  StudentRecord,
  Turn,
} from '@hw/shared'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  isMember,
  loadFileInfos,
  loadHomeworkFor,
  loadHomeworkForTeacher,
  loadSubmission,
  toFileInfo,
  toHomework,
  toStudentHomework,
} from '../access.js'
import { requireRole, requireUser } from '../auth.js'
import type { AppEnv } from '../context.js'
import {
  classMembers,
  classes,
  conversations,
  evaluations,
  files,
  homeworks,
  submissions,
  turns,
  users,
} from '../db/schema.js'
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js'
import { newId } from '../lib/ids.js'
import { parseJson } from '../lib/validate.js'
import { tokensUsed, usageByStudent } from '../stats.js'
import { readUploadForm, saveUpload } from '../uploads.js'

const aiConfigSchema = z.object({
  model: z.string().min(1),
  teachingMode: z.enum(['socratic', 'explain', 'open', 'custom']),
  systemPrompt: z.string().max(20_000),
  allowWebSearch: z.boolean(),
  allowFileUpload: z.boolean(),
  allowThinking: z.boolean(),
  tokenBudget: z.number().int().positive().nullable(),
})

const homeworkFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(50_000),
  startAt: z.iso.datetime({ offset: true }),
  dueAt: z.iso.datetime({ offset: true }),
  status: z.enum(['draft', 'published']),
  allowLateSubmission: z.boolean(),
  aiConfig: aiConfigSchema,
}

const createBody = z.object({ classId: z.string(), ...homeworkFields })
const updateBody = z.object(homeworkFields).partial()

const submissionBody = z.object({
  content: z.string().max(200_000),
  fileIds: z.array(z.string()).max(20).default([]),
})

const gradeBody = z.object({
  score: z.number().min(0).max(1000).nullable(),
  comment: z.string().max(20_000),
})

const checkWindow = (startAt: string | Date, dueAt: string | Date) => {
  if (new Date(dueAt) <= new Date(startAt)) {
    throw badRequest('截止时间必须晚于开始时间', 'The due date must be after the start date')
  }
}

const checkModel = (c: Context<AppEnv>, model: string) => {
  if (!c.var.deps.providers.forModel(model)) {
    throw badRequest(`模型「${model}」不可用`, `Model "${model}" is not available`)
  }
}

const toGrade = (row: typeof evaluations.$inferSelect | undefined): Grade | null =>
  row
    ? {
        score: row.teacherScore,
        comment: row.teacherComment,
        gradedAt: row.gradedAt?.toISOString() ?? null,
      }
    : null

const loadGrade = async (c: Context<AppEnv>, homeworkId: string, studentId: string) => {
  const [row] = await c.var.deps.db
    .select()
    .from(evaluations)
    .where(and(eq(evaluations.homeworkId, homeworkId), eq(evaluations.studentId, studentId)))
  return toGrade(row)
}

const loadClassStudents = (c: Context<AppEnv>, classId: string) =>
  c.var.deps.db
    .select({ id: users.id, name: users.name, username: users.username })
    .from(classMembers)
    .innerJoin(users, eq(users.id, classMembers.studentId))
    .where(eq(classMembers.classId, classId))
    .orderBy(asc(classMembers.createdAt))

const loadTeacherStudent = async (c: Context<AppEnv>) => {
  const teacher = requireRole(c, 'teacher')
  const access = await loadHomeworkForTeacher(c.var.deps.db, c.req.param('id') ?? '', teacher)
  const studentId = c.req.param('studentId') ?? ''
  const [student] = await c.var.deps.db
    .select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(eq(users.id, studentId))
  if (!student || !(await isMember(c.var.deps.db, access.klass.id, studentId))) {
    throw notFound('学生不在这个班级', 'Student is not in this class')
  }
  return { ...access, student }
}

const csvCell = (value: string | number | null) => {
  const text = value === null ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export const homeworkRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const user = requireUser(c)
    const { db, now } = c.var.deps
    if (user.role === 'teacher') {
      const rows = await db
        .select({ homework: homeworks, className: classes.name })
        .from(homeworks)
        .innerJoin(classes, eq(classes.id, homeworks.classId))
        .where(eq(classes.teacherId, user.id))
        .orderBy(desc(homeworks.dueAt))
      return c.json({ homeworks: rows.map((r) => toHomework(r.homework, r.className, now())) })
    }
    const rows = await db
      .select({ homework: homeworks, className: classes.name })
      .from(homeworks)
      .innerJoin(classes, eq(classes.id, homeworks.classId))
      .innerJoin(classMembers, eq(classMembers.classId, classes.id))
      .where(and(eq(classMembers.studentId, user.id), eq(homeworks.status, 'published')))
      .orderBy(desc(homeworks.dueAt))
    const result = await Promise.all(
      rows.map(async (r) =>
        toStudentHomework(r.homework, r.className, now(), {
          tokens: await tokensUsed(db, r.homework.id, user.id),
          submission: await loadSubmission(db, r.homework.id, user.id),
        })
      )
    )
    return c.json({ homeworks: result })
  })
  .post('/', async (c) => {
    const teacher = requireRole(c, 'teacher')
    const body = await parseJson(c, createBody)
    const { db, now } = c.var.deps
    const [klass] = await db
      .select()
      .from(classes)
      .where(and(eq(classes.id, body.classId), eq(classes.teacherId, teacher.id)))
    if (!klass) {
      throw notFound('班级不存在', 'Class not found')
    }
    checkWindow(body.startAt, body.dueAt)
    checkModel(c, body.aiConfig.model)
    const [row] = await db
      .insert(homeworks)
      .values({
        id: newId('hw'),
        classId: klass.id,
        title: body.title,
        description: body.description,
        startAt: new Date(body.startAt),
        dueAt: new Date(body.dueAt),
        status: body.status,
        allowLateSubmission: body.allowLateSubmission,
        aiConfig: body.aiConfig,
      })
      .returning()
    return c.json({ homework: toHomework(row!, klass.name, now()) })
  })
  .get('/:id', async (c) => {
    const user = requireUser(c)
    const { db, now } = c.var.deps
    const { homework, klass, isTeacher } = await loadHomeworkFor(db, c.req.param('id'), user)
    if (isTeacher) {
      return c.json({ homework: toHomework(homework, klass.name, now()) })
    }
    return c.json({
      homework: toStudentHomework(homework, klass.name, now(), {
        tokens: await tokensUsed(db, homework.id, user.id),
        submission: await loadSubmission(db, homework.id, user.id),
      }),
    })
  })
  .patch('/:id', async (c) => {
    const teacher = requireRole(c, 'teacher')
    const { db, now } = c.var.deps
    const { homework, klass } = await loadHomeworkForTeacher(db, c.req.param('id'), teacher)
    const body = await parseJson(c, updateBody)
    checkWindow(body.startAt ?? homework.startAt, body.dueAt ?? homework.dueAt)
    if (body.aiConfig) {
      checkModel(c, body.aiConfig.model)
    }
    const [row] = await db
      .update(homeworks)
      .set({
        ...body,
        startAt: body.startAt ? new Date(body.startAt) : undefined,
        dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
        updatedAt: now(),
      })
      .where(eq(homeworks.id, homework.id))
      .returning()
    return c.json({ homework: toHomework(row!, klass.name, now()) })
  })
  .get('/:id/overview', async (c) => {
    const teacher = requireRole(c, 'teacher')
    const { db, now, config } = c.var.deps
    const { homework, klass } = await loadHomeworkForTeacher(db, c.req.param('id'), teacher)
    const students = await loadClassStudents(c, klass.id)
    const usage = await usageByStudent(db, homework.id, config.timezone)
    const subs = await db.select().from(submissions).where(eq(submissions.homeworkId, homework.id))
    const grades = await db.select().from(evaluations).where(eq(evaluations.homeworkId, homework.id))
    const progress: StudentProgress[] = students.map((student) => {
      const sub = subs.find((s) => s.studentId === student.id)
      return {
        student,
        ...usage.get(student.id),
        submission: sub ? { submittedAt: sub.submittedAt.toISOString(), isLate: sub.isLate } : null,
        grade: toGrade(grades.find((g) => g.studentId === student.id)),
      }
    })
    const overview: HomeworkOverview = { homework: toHomework(homework, klass.name, now()), students: progress }
    return c.json(overview)
  })
  .get('/:id/export.csv', async (c) => {
    const teacher = requireRole(c, 'teacher')
    const { db, config } = c.var.deps
    const { homework, klass } = await loadHomeworkForTeacher(db, c.req.param('id'), teacher)
    const students = await loadClassStudents(c, klass.id)
    const usage = await usageByStudent(db, homework.id, config.timezone)
    const subs = await db.select().from(submissions).where(eq(submissions.homeworkId, homework.id))
    const grades = await db.select().from(evaluations).where(eq(evaluations.homeworkId, homework.id))
    const header = ['username', 'name', 'turns', 'tokens', 'active_days', 'submitted_at', 'late', 'score', 'comment']
    const lines = [header.join(',')]
    for (const student of students) {
      const stats = usage.get(student.id)
      const sub = subs.find((s) => s.studentId === student.id)
      const grade = grades.find((g) => g.studentId === student.id)
      lines.push(
        [
          student.username,
          student.name,
          stats.turns,
          stats.tokens,
          stats.activeDays,
          sub?.submittedAt.toISOString() ?? null,
          sub ? (sub.isLate ? 'yes' : 'no') : null,
          grade?.teacherScore ?? null,
          grade?.teacherComment ?? null,
        ]
          .map(csvCell)
          .join(',')
      )
    }
    c.header('Content-Type', 'text/csv; charset=utf-8')
    c.header('Content-Disposition', `attachment; filename="${homework.id}.csv"`)
    // BOM 让 Excel 正确识别中文
    return c.body(`﻿${lines.join('\r\n')}\r\n`)
  })
  .get('/:id/students/:studentId', async (c) => {
    const { homework, klass, student } = await loadTeacherStudent(c)
    const { db, now } = c.var.deps
    const convRows = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.homeworkId, homework.id), eq(conversations.userId, student.id)))
      .orderBy(asc(conversations.createdAt))
    const turnRows = convRows.length
      ? await db
          .select()
          .from(turns)
          .where(inArray(turns.conversationId, convRows.map((r) => r.id)))
          .orderBy(asc(turns.createdAt))
      : []
    const infos = await loadFileInfos(db, [...new Set(turnRows.flatMap((t) => t.fileIds))])
    const result: Conversation[] = convRows.map((conv) => ({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt.toISOString(),
      turns: turnRows
        .filter((t) => t.conversationId === conv.id)
        .map(
          (t): Turn => ({
            id: t.id,
            kind: t.kind,
            status: t.status,
            userMessageId: t.userMessageId,
            parentMessageId: t.parentMessageId,
            assistantMessageId: t.assistantMessageId,
            userContent: t.userContent,
            assistantContent: t.assistantContent,
            files: t.fileIds.flatMap((id) => infos.get(id) ?? []),
            model: t.model,
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            latencyMs: t.latencyMs,
            stopReason: t.stopReason,
            error: t.error,
            createdAt: t.createdAt.toISOString(),
          })
        ),
    }))
    const record: StudentRecord = {
      student,
      homework: toHomework(homework, klass.name, now()),
      conversations: result,
      submission: await loadSubmission(db, homework.id, student.id),
      grade: await loadGrade(c, homework.id, student.id),
    }
    return c.json(record)
  })
  .put('/:id/students/:studentId/grade', async (c) => {
    const { homework, student } = await loadTeacherStudent(c)
    const body = await parseJson(c, gradeBody)
    const { db, now } = c.var.deps
    await db
      .insert(evaluations)
      .values({
        id: newId('eval'),
        homeworkId: homework.id,
        studentId: student.id,
        teacherScore: body.score,
        teacherComment: body.comment,
        gradedAt: now(),
      })
      .onConflictDoUpdate({
        target: [evaluations.homeworkId, evaluations.studentId],
        set: { teacherScore: body.score, teacherComment: body.comment, gradedAt: now() },
      })
    return c.json({ grade: await loadGrade(c, homework.id, student.id) })
  })
  .put('/:id/submission', async (c) => {
    const student = requireRole(c, 'student')
    const { db, now } = c.var.deps
    const { homework } = await loadHomeworkFor(db, c.req.param('id'), student)
    const body = await parseJson(c, submissionBody)
    const at = now()
    if (at < homework.startAt) {
      throw forbidden('作业还没有开始', 'This homework has not started yet')
    }
    const isLate = at > homework.dueAt
    if (isLate && !homework.allowLateSubmission) {
      throw forbidden('作业已截止，不能再提交', 'This homework is closed for submissions')
    }
    if (!body.content.trim() && body.fileIds.length === 0) {
      throw badRequest('提交内容不能为空', 'The submission is empty')
    }
    if (body.fileIds.length) {
      const owned = await db
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            inArray(files.id, body.fileIds),
            eq(files.ownerId, student.id),
            eq(files.homeworkId, homework.id),
            eq(files.purpose, 'submission')
          )
        )
      if (owned.length !== new Set(body.fileIds).size) {
        throw badRequest('附件无效，请重新上传', 'Invalid attachment, please upload it again')
      }
    }
    await db
      .insert(submissions)
      .values({
        id: newId('sub'),
        homeworkId: homework.id,
        studentId: student.id,
        content: body.content,
        fileIds: body.fileIds,
        isLate,
        submittedAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [submissions.homeworkId, submissions.studentId],
        set: { content: body.content, fileIds: body.fileIds, isLate, updatedAt: at },
      })
    return c.json({ submission: await loadSubmission(db, homework.id, student.id) })
  })
  .post('/:id/submission/files', async (c) => {
    const student = requireRole(c, 'student')
    const deps = c.var.deps
    const { homework } = await loadHomeworkFor(deps.db, c.req.param('id'), student)
    if (deps.now() > homework.dueAt && !homework.allowLateSubmission) {
      throw new HttpError(403, { zh: '作业已截止', en: 'This homework is closed' })
    }
    const { file } = await readUploadForm(c.req.raw)
    const { row } = await saveUpload(deps, {
      ownerId: student.id,
      homeworkId: homework.id,
      purpose: 'submission',
      file,
    })
    return c.json({ file: toFileInfo(row) })
  })
