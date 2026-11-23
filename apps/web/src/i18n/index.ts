import { chatDemoOverrides } from '../platform/i18n.js'
import { en } from './en.js'

export type TranslationKey = keyof typeof en
export type TranslationParams = Record<string, string | number>
export type TranslationMessage = { key: TranslationKey; params?: TranslationParams }
/** A message with a text link after it (opens in a new window); `type: 'error'` adds an error icon. */
export type LinkedMessage = TranslationMessage & {
  type?: 'error'
  link?: { key: TranslationKey; href: string }
}

export const isTranslationKey = (key: unknown): key is TranslationKey =>
  typeof key === 'string' && Object.hasOwn(en, key)

const messages: Record<TranslationKey, string> = { ...en, ...chatDemoOverrides }

/** UI text. The app is English only; the lookup stays a function so text can carry parameters. */
export const translate = (key: TranslationKey, params?: TranslationParams): string =>
  messages[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
  })

export const useTranslate = () => translate
