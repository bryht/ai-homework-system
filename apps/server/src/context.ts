import type { User } from '@hw/shared'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { ProviderRegistry } from './gateway/providers.js'
import type { FileStorage } from './storage.js'

export type Deps = {
  db: Db
  config: Config
  storage: FileStorage
  providers: ProviderRegistry
  /** 可注入的时钟，测试里用来模拟作业的开始和截止 */
  now: () => Date
}

export type AppEnv = {
  Variables: {
    deps: Deps
    user: User | null
  }
}
