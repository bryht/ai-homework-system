import { useSettings } from '../services/settings.js'
import { authHeaders } from './token.js'

/** Backend address; empty when the API is served from the same origin (Docker Compose). */
export const API_BASE: string = __API_ORIGIN__

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

let onUnauthorized: (() => void) | null = null

/** 会话过期时的回调（回到登录页） */
export const setUnauthorizedHandler = (handler: () => void) => {
  onUnauthorized = handler
}

export const acceptLanguage = () => useSettings.getState().locale

/** 后端 REST 接口；Bearer 令牌登录，错误统一为 ApiFailure（message 已按界面语言本地化） */
export const api = async <T>(
  path: string,
  options: { method?: string; json?: unknown; body?: BodyInit } = {}
): Promise<T> => {
  const headers: Record<string, string> = { 'Accept-Language': acceptLanguage(), ...authHeaders() }
  let body = options.body
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  let response: Response
  try {
    response = await fetch(API_BASE + path, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiFailure(0, acceptLanguage() === 'zh-CN' ? '网络连接失败' : 'Network error')
  }
  if (!response.ok) {
    let message = response.statusText
    try {
      const data = (await response.json()) as { error?: { message?: string } }
      message = data.error?.message ?? message
    } catch {
      // 非 JSON 错误体
    }
    if (response.status === 401 && !path.startsWith('/api/auth/login')) {
      onUnauthorized?.()
    }
    throw new ApiFailure(response.status, message)
  }
  return (await response.json()) as T
}

/**
 * Downloads a protected file (attachments, CSV). Links cannot carry the Authorization header,
 * so the file is fetched and handed to the browser as a blob.
 */
export const downloadFile = async (path: string, filename: string) => {
  const response = await fetch(API_BASE + path, {
    headers: { 'Accept-Language': acceptLanguage(), ...authHeaders() },
  })
  if (!response.ok) {
    if (response.status === 401) {
      onUnauthorized?.()
    }
    throw new ApiFailure(response.status, response.statusText)
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
