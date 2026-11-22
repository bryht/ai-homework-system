import {
  getHomeworkPhase,
  type FileInfo,
  type Homework,
  type StudentHomework,
  type Submission,
  type User,
} from '@hw/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from './db/client.js'
import { classes, classMembers, files, homeworks, submissions } from './db/schema.js'
import { forbidden, notFound } from './lib/errors.js'

type HomeworkRow = typeof homeworks.$inferSelect
type ClassRow = typeof classes.$inferSelect

export type HomeworkAccess = {
  homework: HomeworkRow
  klass: ClassRow
  /** 老师在自己的作业里试用 AI（预览），不受时间窗口和额度限制，也不计入统计 */
  isTeacher: boolean
}

const homeworkNotFound = () => notFound('作业不存在', 'Homework not found')

const loadHomework = async (db: Db, homeworkId: string) => {
  const [row] = await db
    .select({ homework: homeworks, klass: classes })
    .from(homeworks)
    .innerJoin(classes, eq(classes.id, homeworks.classId))
    .where(eq(homeworks.id, homeworkId))
  if (!row) {
    throw homeworkNotFound()
  }
  return row
}

export const isMember = async (db: Db, classId: string, studentId: string) => {
  const [row] = await db
    .select({ classId: classMembers.classId })
    .from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.studentId, studentId)))
  return row !== undefined
}

/** 老师只能访问自己班级的作业；学生只能访问自己班级里已发布的作业 */
export const loadHomeworkFor = async (db: Db, homeworkId: string, user: User): Promise<HomeworkAccess> => {
  const { homework, klass } = await loadHomework(db, homeworkId)
  if (user.role === 'teacher') {
    if (klass.teacherId !== user.id) {
      throw homeworkNotFound()
    }
    return { homework, klass, isTeacher: true }
  }
  if (homework.status !== 'published' || !(await isMember(db, klass.id, user.id))) {
    throw homeworkNotFound()
  }
  return { homework, klass, isTeacher: false }
}

export const loadHomeworkForTeacher = async (db: Db, homeworkId: string, user: User) => {
  if (user.role !== 'teacher') {
    throw forbidden()
  }
  return loadHomeworkFor(db, homeworkId, user)
}

export const toHomework = (row: HomeworkRow, className: string, now: Date): Homework => ({
  id: row.id,
  classId: row.classId,
  className,
  title: row.title,
  description: row.description,
  startAt: row.startAt.toISOString(),
  dueAt: row.dueAt.toISOString(),
  status: row.status,
  allowLateSubmission: row.allowLateSubmission,
  aiConfig: row.aiConfig,
  createdAt: row.createdAt.toISOString(),
  phase: getHomeworkPhase(row.startAt, row.dueAt, now),
})

export const toStudentHomework = (
  row: HomeworkRow,
  className: string,
  now: Date,
  extra: { tokens: number; submission: Submission | null }
): StudentHomework => {
  const { aiConfig, ...rest } = toHomework(row, className, now)
  return {
    ...rest,
    ai: {
      allowWebSearch: aiConfig.allowWebSearch,
      allowFileUpload: aiConfig.allowFileUpload,
      allowThinking: aiConfig.allowThinking,
    },
    usage: { tokens: extra.tokens, tokenBudget: aiConfig.tokenBudget },
    submission: extra.submission,
  }
}

export const toFileInfo = (row: typeof files.$inferSelect): FileInfo => ({
  id: row.id,
  filename: row.filename,
  mimeType: row.mimeType,
  size: row.size,
  createdAt: row.createdAt.toISOString(),
})

export const loadFileInfos = async (db: Db, ids: string[]): Promise<Map<string, FileInfo>> => {
  if (ids.length === 0) {
    return new Map()
  }
  const rows = await db.select().from(files).where(inArray(files.id, ids))
  return new Map(rows.map((row) => [row.id, toFileInfo(row)]))
}

export const loadSubmission = async (
  db: Db,
  homeworkId: string,
  studentId: string
): Promise<Submission | null> => {
  const [row] = await db
    .select()
    .from(submissions)
    .where(and(eq(submissions.homeworkId, homeworkId), eq(submissions.studentId, studentId)))
  if (!row) {
    return null
  }
  const infos = await loadFileInfos(db, row.fileIds)
  return {
    id: row.id,
    content: row.content,
    files: row.fileIds.flatMap((id) => infos.get(id) ?? []),
    submittedAt: row.submittedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    isLate: row.isLate,
  }
}
