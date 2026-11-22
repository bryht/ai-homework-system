import { and, eq, sql } from 'drizzle-orm'
import type { Db } from './db/client.js'
import { turns } from './db/schema.js'

export type UsageStats = {
  conversations: number
  turns: number
  tokens: number
  activeDays: number
  firstActiveAt: string | null
  lastActiveAt: string | null
}

const emptyStats = (): UsageStats => ({
  conversations: 0,
  turns: 0,
  tokens: 0,
  activeDays: 0,
  firstActiveAt: null,
  lastActiveAt: null,
})

/** 按学生汇总某个作业的 AI 使用情况。试点规模（一个班）直接在内存里算 */
export const usageByStudent = async (db: Db, homeworkId: string, timezone: string) => {
  const rows = await db
    .select({
      userId: turns.userId,
      conversationId: turns.conversationId,
      createdAt: turns.createdAt,
      tokens: sql<number>`${turns.inputTokens} + ${turns.outputTokens}`,
    })
    .from(turns)
    .where(eq(turns.homeworkId, homeworkId))
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' })
  const acc = new Map<string, { stats: UsageStats; conversations: Set<string>; days: Set<string> }>()
  for (const row of rows) {
    let entry = acc.get(row.userId)
    if (!entry) {
      entry = { stats: emptyStats(), conversations: new Set(), days: new Set() }
      acc.set(row.userId, entry)
    }
    const at = row.createdAt.toISOString()
    entry.stats.turns += 1
    entry.stats.tokens += Number(row.tokens)
    entry.conversations.add(row.conversationId)
    entry.days.add(day.format(row.createdAt))
    if (!entry.stats.firstActiveAt || at < entry.stats.firstActiveAt) {
      entry.stats.firstActiveAt = at
    }
    if (!entry.stats.lastActiveAt || at > entry.stats.lastActiveAt) {
      entry.stats.lastActiveAt = at
    }
  }
  const result = new Map<string, UsageStats>()
  for (const [userId, entry] of acc) {
    result.set(userId, {
      ...entry.stats,
      conversations: entry.conversations.size,
      activeDays: entry.days.size,
    })
  }
  return { get: (userId: string) => result.get(userId) ?? emptyStats() }
}

export const tokensUsed = async (db: Db, homeworkId: string, userId: string): Promise<number> => {
  const [row] = await db
    .select({ total: sql<string | null>`sum(${turns.inputTokens} + ${turns.outputTokens})` })
    .from(turns)
    .where(and(eq(turns.homeworkId, homeworkId), eq(turns.userId, userId)))
  return Number(row?.total ?? 0)
}
