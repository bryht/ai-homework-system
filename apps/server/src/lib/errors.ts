import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** 双语文案；根据请求的 Accept-Language 选择 */
export type LocalText = { zh: string; en: string }

/**
 * 业务错误，统一转成 Anthropic 风格的错误体 { error: { type, message } }，
 * chat-demo 不用改就能显示 message。
 */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly text: LocalText,
    readonly type = 'invalid_request_error'
  ) {
    super(text.en)
  }
}

export const pickLang = (acceptLanguage: string | undefined): 'zh' | 'en' =>
  !acceptLanguage || acceptLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en'

export const badRequest = (zh: string, en: string) => new HttpError(400, { zh, en })

export const unauthorized = () =>
  new HttpError(401, { zh: '登录已过期，请重新登录', en: 'Please sign in again' }, 'authentication_error')

export const forbidden = (
  zh = '没有权限执行此操作',
  en = 'You do not have permission to do this'
) => new HttpError(403, { zh, en }, 'permission_error')

export const notFound = (zh = '内容不存在', en = 'Not found') =>
  new HttpError(404, { zh, en }, 'not_found_error')
