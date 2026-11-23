import type { HomeworkPhase } from '@hw/shared'
import { LOCALE } from '../../services/settings.js'
import type { Pt } from '../i18n.js'

export const formatDateTime = (iso: string | null | undefined) => {
  if (!iso) {
    return '—'
  }
  return new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export const formatNumber = (n: number) =>
  new Intl.NumberFormat(LOCALE).format(n)

/** 「还剩 3 天」/「2 小时后开始」 */
export const describeRemaining = (
  phase: HomeworkPhase,
  startAt: string,
  dueAt: string,
  pt: Pt,
  now = Date.now()
) => {
  if (phase === 'closed') {
    return pt('phaseClosed')
  }
  const target = new Date(phase === 'upcoming' ? startAt : dueAt).getTime()
  const ms = Math.max(0, target - now)
  const hours = ms / 3_600_000
  if (phase === 'upcoming') {
    return hours >= 24
      ? pt('startsInDays', { n: Math.ceil(hours / 24) })
      : pt('startsInHours', { n: Math.max(1, Math.ceil(hours)) })
  }
  if (hours >= 24) {
    return pt('remainingDays', { n: Math.floor(hours / 24) })
  }
  if (hours >= 1) {
    return pt('remainingHours', { n: Math.floor(hours) })
  }
  return pt('remainingMinutes', { n: Math.max(1, Math.ceil(ms / 60_000)) })
}

/** <input type="datetime-local"> 使用本地时间，不带时区 */
export const toLocalInput = (iso: string) => {
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const fromLocalInput = (value: string) => new Date(value).toISOString()

export const formatBytes = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`

/** 浏览器下载一段文本（CSV 等） */
export const downloadText = (filename: string, text: string, type = 'text/csv;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
