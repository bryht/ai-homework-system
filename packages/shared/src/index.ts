/**
 * Business types and constants shared by the server and the web app.
 * Types and plain data only, with no runtime dependencies; consumers compile the source directly.
 */

export type Role = 'teacher' | 'student'

export type User = {
  id: string
  role: Role
  name: string
  username: string
}

/** Teaching mode: picks the default teaching prompt template, which teachers can edit */
export type TeachingMode = 'socratic' | 'explain' | 'open' | 'custom'

/** Per-homework AI settings, enforced by the server gateway */
export type AiConfig = {
  /** Model ID, one of GET /api/models */
  model: string
  teachingMode: TeachingMode
  /** The teacher's teaching prompt; the gateway puts it first in the system prompt and students cannot override it */
  systemPrompt: string
  allowWebSearch: boolean
  allowFileUpload: boolean
  allowThinking: boolean
  /** Tokens (input + output) each student may use on this homework; null means unlimited */
  tokenBudget: number | null
}

export type HomeworkStatus = 'draft' | 'published'

/** From the current time: upcoming / open / closed */
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

/** The homework as a student sees it: without the teacher's teaching prompt */
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

/** Initial passwords returned once after adding students; the server keeps no plain text. password is null for existing accounts added to the class */
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

/** One row per student in the teacher's homework overview */
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

/** The kind of turn, as inferred by the gateway */
export type TurnKind = 'new' | 'edit' | 'regenerate' | 'continue'

export type TurnStatus = 'streaming' | 'ok' | 'aborted' | 'error'

/** Content blocks in Anthropic format, stored as-is; the web app renders them by type */
export type ContentBlock = { type: string; [key: string]: unknown }

export type Turn = {
  id: string
  kind: TurnKind
  status: TurnStatus
  /** chat-demo local message ID, used to rebuild branches */
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

/** API error body in Anthropic error format, so chat-demo can show message as-is */
export type ApiErrorBody = {
  error: { type: string; message: string }
}

/** Teaching mode templates. Picking a mode fills the prompt box; teachers can edit it further. */
export const TEACHING_TEMPLATES: Record<Exclude<TeachingMode, 'custom'>, string> = {
  socratic: [
    'You are a patient learning guide helping a student with their homework.',
    '- Never give the final answer, complete code or a complete essay for the homework.',
    '- Guide the student with questions: first check they understand the task, then break it into small steps and move one step at a time.',
    '- When the student is wrong, point out the problem in their reasoning and let them fix it.',
    '- If the student asks for the answer directly, politely decline and give a hint for the next step.',
    '- You may explain related concepts and use examples that differ from the homework.',
  ].join('\n'),
  explain: [
    'You are a clear, friendly teaching assistant helping a student with their homework.',
    '- You may explain concepts, methods and approaches in detail, and give worked examples that are similar to, but not the same as, the homework.',
    '- Do not do the homework itself: for homework questions give only the approach and key hints.',
    '- Encourage the student to explain their own understanding, and correct any mistakes.',
  ].join('\n'),
  open: [
    'You are a learning assistant helping a student with their homework.',
    '- You may answer the student\'s questions directly.',
    '- Show your reasoning so the student can follow and check it.',
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

/** Custom headers chat-demo sends to the gateway */
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
