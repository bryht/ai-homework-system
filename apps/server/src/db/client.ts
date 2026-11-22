import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from './schema.js'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

export type DbHandle = {
  db: Db
  close: () => Promise<void>
}

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

/**
 * 有 DATABASE_URL 时连接 Postgres（Supabase / Neon / 自建）；
 * 没有时使用 PGlite（进程内的 Postgres），dataDir 为 null 时只在内存中（测试用）。
 * 两种方式都是 Postgres 方言，同一套 schema 和迁移。启动时自动执行迁移。
 */
export const openDatabase = async (options: {
  databaseUrl?: string
  dataDir: string | null
}): Promise<DbHandle> => {
  if (options.databaseUrl) {
    const { default: postgres } = await import('postgres')
    const { drizzle } = await import('drizzle-orm/postgres-js')
    const { migrate } = await import('drizzle-orm/postgres-js/migrator')
    const client = postgres(options.databaseUrl, { max: 10, onnotice: () => {} })
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    return { db: db as unknown as Db, close: () => client.end() }
  }
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  if (options.dataDir) {
    mkdirSync(options.dataDir, { recursive: true })
  }
  const client = options.dataDir ? new PGlite(options.dataDir) : new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
  return { db: db as unknown as Db, close: () => client.close() }
}
