import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 读取仓库根目录的 .env（如果有）；已经设置的环境变量优先 */
export const loadDotEnv = () => {
  const file = path.join(repoRoot, '.env')
  if (existsSync(file)) {
    process.loadEnvFile(file)
  }
}

export type Config = {
  port: number
  production: boolean
  databaseUrl?: string
  /** PGlite 数据和上传文件所在目录；null 表示全部放内存（测试用） */
  dataDir: string | null
  /** 前端构建产物目录，生产环境由后端直接托管 */
  webDist: string
  /** 统计「活跃天数」时按哪个时区切分日期 */
  timezone: string
  sessionDays: number
  cookieSecure: boolean
  deepseek: { apiKey?: string; baseUrl: string }
  /** 没有配置任何真实模型时自动启用模拟模型，方便本地开发 */
  enableMock: boolean
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const production = env.NODE_ENV === 'production'
  const deepseekKey = env.DEEPSEEK_API_KEY || undefined
  return {
    port: Number(env.PORT ?? 8787),
    production,
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: path.resolve(env.DATA_DIR ?? path.join(repoRoot, '.data')),
    webDist: path.resolve(env.WEB_DIST ?? path.join(repoRoot, 'apps/web/dist')),
    timezone: env.APP_TIMEZONE ?? 'UTC',
    sessionDays: Number(env.SESSION_DAYS ?? 14),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
    deepseek: {
      apiKey: deepseekKey,
      baseUrl: (env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    },
    enableMock: env.ENABLE_MOCK_AI ? env.ENABLE_MOCK_AI === 'true' : !deepseekKey,
  }
}
