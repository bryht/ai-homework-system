/**
 * 前后端共享的业务类型与常量。
 * 只放类型和纯数据，不引入运行时依赖，前端（rspack）和后端（tsx）都直接编译源码。
 */

export type Role = 'teacher' | 'student'

export type User = {
  id: string
  role: Role
  name: string
  username: string
}

/** 教学模式：决定默认的系统提示词模板，老师可以在模板基础上修改 */
export type TeachingMode = 'socratic' | 'explain' | 'open' | 'custom'

/** 每个作业单独配置的 AI 行为，由后端网关强制执行 */
export type AiConfig = {
  /** 模型 ID，取值见 GET /api/models */
  model: string
  teachingMode: TeachingMode
  /** 老师的教学提示词，网关会放在系统提示词最前面，学生无法覆盖 */
  systemPrompt: string
  allowWebSearch: boolean
  allowFileUpload: boolean
  allowThinking: boolean
  /** 每个学生在本作业中可用的 Token 总量（输入 + 输出）；null 表示不限 */
  tokenBudget: number | null
}

export type HomeworkStatus = 'draft' | 'published'

/** 根据当前时间计算：未开始 / 进行中 / 已截止 */
export type HomeworkPhase = 'upcoming' | 'open' | 'closed'

export type Homework = {
  id: string
  classId: string
  className: string
  title: string
  /** Markdown */
  description: string
  /** ISO 8601 */
  startAt: string
  dueAt: string
  status: HomeworkStatus
  allowLateSubmission: boolean
  aiConfig: AiConfig
  createdAt: string
  phase: HomeworkPhase
}

/** 学生看到的作业：不包含老师的教学提示词 */
export type StudentHomework = Omit<Homework, 'aiConfig'> & {
  ai: Pick<AiConfig, 'allowWebSearch' | 'allowFileUpload' | 'allowThinking'>
  usage: { tokens: number; tokenBudget: number | null }
  submission: Submission | null
}

export type ClassInfo = {
  id: string
  name: string
  studentCount: number
  createdAt: string
}

export type ClassStudent = {
  id: string
  name: string
  username: string
}

/** 批量添加学生后一次性返回的初始密码，服务端不保存明文；已有账号加入班级时 password 为 null */
export type CreatedCredential = {
  id: string
  name: string
  username: string
  password: string | null
}

export type FileInfo = {
  id: string
  filename: string
  mimeType: string
  size: number
  createdAt: string
}

export type Submission = {
  id: string
  content: string
  files: FileInfo[]
  submittedAt: string
  updatedAt: string
  isLate: boolean
}

export type Grade = {
  score: number | null
  comment: string
  gradedAt: string | null
}

/** 老师端作业总览里每个学生的一行 */
export type StudentProgress = {
  student: ClassStudent
  conversations: number
  turns: number
  tokens: number
  activeDays: number
  firstActiveAt: string | null
  lastActiveAt: string | null
  submission: Pick<Submission, 'submittedAt' | 'isLate'> | null
  grade: Grade | null
}

export type HomeworkOverview = {
  homework: Homework
  students: StudentProgress[]
}

/** 网关推断的本轮类型 */
export type TurnKind = 'new' | 'edit' | 'regenerate' | 'continue'

export type TurnStatus = 'streaming' | 'ok' | 'aborted' | 'error'

/** Anthropic 格式的内容块，原样存储；前端按 type 渲染 */
export type ContentBlock = { type: string; [key: string]: unknown }

export type Turn = {
  id: string
  kind: TurnKind
  status: TurnStatus
  /** chat-demo 本地消息 ID，用于还原分支 */
  userMessageId: string | null
  parentMessageId: string | null
  assistantMessageId: string | null
  userContent: ContentBlock[]
  assistantContent: ContentBlock[]
  files: FileInfo[]
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number | null
  stopReason: string | null
  error: string | null
  createdAt: string
}

export type Conversation = {
  id: string
  title: string
  createdAt: string
  turns: Turn[]
}

export type StudentRecord = {
  student: ClassStudent
  homework: Homework
  conversations: Conversation[]
  submission: Submission | null
  grade: Grade | null
}

export type ModelOption = {
  id: string
  label: string
  provider: string
  supportsThinking: boolean
  supportsWebSearch: boolean
  supportsFiles: boolean
}

/** API 错误响应体，与 Anthropic 错误格式一致，chat-demo 可以直接展示 message */
export type ApiErrorBody = {
  error: { type: string; message: string }
}

/** 教学模式模板。老师选择模式后，模板填入提示词输入框，可以继续修改 */
export const TEACHING_TEMPLATES: Record<Exclude<TeachingMode, 'custom'>, string> = {
  socratic: [
    '你是一名耐心的学习引导者，正在帮助学生完成作业。',
    '- 不要直接给出作业的最终答案、完整代码或完整文章。',
    '- 通过提问引导学生思考：先确认学生理解了题目，再把问题拆成小步骤，一次只推进一步。',
    '- 学生答错时，指出思路中的问题，让学生自己修正。',
    '- 学生要求直接给答案时，礼貌地拒绝，并给出下一步的提示。',
    '- 可以讲解相关概念，可以举与作业不同的例子。',
  ].join('\n'),
  explain: [
    '你是一名讲解清楚的老师助手，正在帮助学生完成作业。',
    '- 可以详细讲解概念、方法和解题思路，可以给出与作业类似但不相同的例题和完整解答。',
    '- 不要直接替学生完成作业本身，作业中的题目只给思路和关键步骤提示。',
    '- 鼓励学生说出自己的理解，并指出其中的错误。',
  ].join('\n'),
  open: [
    '你是一名学习助手，正在帮助学生完成作业。',
    '- 可以直接回答学生的问题。',
    '- 回答时说明推理过程，方便学生理解和核对。',
  ].join('\n'),
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  model: 'deepseek-flash',
  teachingMode: 'socratic',
  systemPrompt: TEACHING_TEMPLATES.socratic,
  allowWebSearch: false,
  allowFileUpload: true,
  allowThinking: true,
  tokenBudget: 500_000,
}

/** chat-demo 发给网关的自定义请求头 */
export const GATEWAY_HEADERS = {
  homeworkId: 'x-hw-homework-id',
  conversationId: 'x-hw-conversation-id',
  userMessageId: 'x-hw-user-message-id',
  parentMessageId: 'x-hw-parent-message-id',
  assistantMessageId: 'x-hw-assistant-message-id',
} as const

export const getHomeworkPhase = (startAt: string | Date, dueAt: string | Date, now = new Date()): HomeworkPhase => {
  if (now < new Date(startAt)) {
    return 'upcoming'
  }
  return now > new Date(dueAt) ? 'closed' : 'open'
}
