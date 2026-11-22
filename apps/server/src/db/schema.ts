import type { AiConfig, ContentBlock } from '@hw/shared'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  role: text('role', { enum: ['teacher', 'student'] }).notNull(),
  name: text('name').notNull(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
})

/** 登录会话；id 是 Cookie 中令牌的 SHA-256，数据库泄露也拿不到可用令牌 */
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
})

export const classes = pgTable('classes', {
  id: text('id').primaryKey(),
  teacherId: text('teacher_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const classMembers = pgTable(
  'class_members',
  {
    classId: text('class_id')
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.classId, t.studentId] })]
)

export const homeworks = pgTable('homeworks', {
  id: text('id').primaryKey(),
  classId: text('class_id')
    .notNull()
    .references(() => classes.id),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  status: text('status', { enum: ['draft', 'published'] }).notNull().default('draft'),
  allowLateSubmission: boolean('allow_late_submission').notNull().default(false),
  aiConfig: jsonb('ai_config').$type<AiConfig>().notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** 一个 chat-demo 会话对应一行；clientSessionId 是浏览器本地的会话 ID */
export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    homeworkId: text('homework_id')
      .notNull()
      .references(() => homeworks.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    clientSessionId: text('client_session_id').notNull(),
    title: text('title').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversations_client_idx').on(t.homeworkId, t.userId, t.clientSessionId)]
)

/**
 * 每次调用模型记一轮。只存本轮新增的学生消息和完整回答，不存整个请求历史，
 * 历史可以用 chat-demo 的消息 ID（userMessageId / parentMessageId）还原。
 */
export const turns = pgTable(
  'turns',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    homeworkId: text('homework_id')
      .notNull()
      .references(() => homeworks.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: ['new', 'edit', 'regenerate', 'continue'] }).notNull(),
    status: text('status', { enum: ['streaming', 'ok', 'aborted', 'error'] }).notNull(),
    userMessageId: text('user_message_id'),
    parentMessageId: text('parent_message_id'),
    assistantMessageId: text('assistant_message_id'),
    userContent: jsonb('user_content').$type<ContentBlock[]>().notNull(),
    assistantContent: jsonb('assistant_content').$type<ContentBlock[]>().notNull().default([]),
    fileIds: jsonb('file_ids').$type<string[]>().notNull().default([]),
    model: text('model').notNull(),
    /** 请求时的功能开关（深度思考、联网搜索）等，便于评估时还原上下文 */
    requestMeta: jsonb('request_meta').$type<Record<string, unknown>>().notNull().default({}),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms'),
    stopReason: text('stop_reason'),
    error: text('error'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('turns_homework_user_idx').on(t.homeworkId, t.userId),
    index('turns_conversation_idx').on(t.conversationId),
  ]
)

export const files = pgTable(
  'files',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    homeworkId: text('homework_id').references(() => homeworks.id),
    purpose: text('purpose', { enum: ['chat', 'submission'] }).notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    /** 存储后端里的键（本地磁盘为相对路径） */
    storageKey: text('storage_key').notNull(),
    /** 已上传到模型供应商时记录供应商和对方的 file_id */
    provider: text('provider'),
    providerFileId: text('provider_file_id'),
    createdAt: createdAt(),
  },
  (t) => [index('files_homework_owner_idx').on(t.homeworkId, t.ownerId)]
)

export const submissions = pgTable(
  'submissions',
  {
    id: text('id').primaryKey(),
    homeworkId: text('homework_id')
      .notNull()
      .references(() => homeworks.id),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id),
    content: text('content').notNull(),
    fileIds: jsonb('file_ids').$type<string[]>().notNull().default([]),
    isLate: boolean('is_late').notNull().default(false),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('submissions_homework_student_idx').on(t.homeworkId, t.studentId)]
)

/**
 * 评估结果。第一期只有老师打分；metrics / ai* 字段留给第二期的自动评估。
 */
export const evaluations = pgTable(
  'evaluations',
  {
    id: text('id').primaryKey(),
    homeworkId: text('homework_id')
      .notNull()
      .references(() => homeworks.id),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id),
    teacherScore: real('teacher_score'),
    teacherComment: text('teacher_comment').notNull().default(''),
    gradedAt: timestamp('graded_at', { withTimezone: true }),
    metrics: jsonb('metrics').$type<Record<string, unknown>>(),
    aiScores: jsonb('ai_scores').$type<Record<string, unknown>>(),
    aiSummary: text('ai_summary'),
    judgeModel: text('judge_model'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('evaluations_homework_student_idx').on(t.homeworkId, t.studentId)]
)
