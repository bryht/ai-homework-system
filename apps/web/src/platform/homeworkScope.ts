import { GATEWAY_HEADERS, type AiConfig, type Homework, type StudentHomework } from '@hw/shared'
import { create } from 'zustand'
import { authHeaders } from './token.js'

/**
 * 当前聊天页所属的作业。chat-demo 的 API 层从这里读作业 ID 拼请求头，
 * 输入框从这里读功能开关，IndexedDB 按「用户 + 作业」分库。
 */
type ScopeState = {
  userId: string | null
  homework: StudentHomework | Homework | null
}

export const useHomeworkScope = create<ScopeState>(() => ({ userId: null, homework: null }))

export const setHomeworkScope = (userId: string, homework: StudentHomework | Homework) =>
  useHomeworkScope.setState({ userId, homework })

export const updateScopedHomework = (homework: StudentHomework | Homework) =>
  useHomeworkScope.setState({ homework })

type AiSwitches = Pick<AiConfig, 'allowWebSearch' | 'allowFileUpload' | 'allowThinking'>

const switchesOf = (homework: StudentHomework | Homework | null): AiSwitches => {
  if (!homework) {
    return { allowWebSearch: false, allowFileUpload: false, allowThinking: false }
  }
  const source = 'aiConfig' in homework ? homework.aiConfig : homework.ai
  return {
    allowWebSearch: source.allowWebSearch,
    allowFileUpload: source.allowFileUpload,
    allowThinking: source.allowThinking,
  }
}

export const useHomeworkAi = (): AiSwitches =>
  useHomeworkScope((state) => switchesOf(state.homework))

export const getHomeworkAi = (): AiSwitches => switchesOf(useHomeworkScope.getState().homework)

/** chat-demo 的 IndexedDB 库名：每个用户的每个作业单独一个库 */
export const getChatDbName = () => {
  const { userId, homework } = useHomeworkScope.getState()
  return userId && homework ? `hw-${userId}-${homework.id}` : 'chat-demo'
}

export type GatewayMeta = {
  conversationId: string
  userMessageId?: string
  parentMessageId?: string | null
  assistantMessageId?: string
}

/** 网关需要的请求头：作业 ID，以及（发消息时）会话和消息 ID，用于存档和还原分支 */
export const getGatewayHeaders = (meta?: GatewayMeta): Record<string, string> => {
  const homework = useHomeworkScope.getState().homework
  const headers: Record<string, string> = authHeaders()
  if (homework) {
    headers[GATEWAY_HEADERS.homeworkId] = homework.id
  }
  if (meta) {
    headers[GATEWAY_HEADERS.conversationId] = meta.conversationId
    if (meta.userMessageId) {
      headers[GATEWAY_HEADERS.userMessageId] = meta.userMessageId
    }
    if (meta.parentMessageId) {
      headers[GATEWAY_HEADERS.parentMessageId] = meta.parentMessageId
    }
    if (meta.assistantMessageId) {
      headers[GATEWAY_HEADERS.assistantMessageId] = meta.assistantMessageId
    }
  }
  return headers
}
