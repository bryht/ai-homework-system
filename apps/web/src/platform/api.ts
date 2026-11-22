import { useSettings } from '../services/settings.js'

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

/** 后端 REST 接口；同源 Cookie 登录，错误统一为 ApiFailure（message 已按界面语言本地化） */
export const api = async <T>(
  path: string,
  options: { method?: string; json?: unknown; body?: BodyInit } = {}
): Promise<T> => {
  const headers: Record<string, string> = { 'Accept-Language': acceptLanguage() }
  let body = options.body
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  let response: Response
  try {
    response = await fetch(path, {
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
