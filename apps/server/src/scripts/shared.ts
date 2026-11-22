import path from 'node:path'
import { loadConfig, loadDotEnv } from '../config.js'
import { openDatabase } from '../db/client.js'

export const openFromEnv = () => {
  loadDotEnv()
  const config = loadConfig()
  return openDatabase({
    databaseUrl: config.databaseUrl,
    dataDir: config.dataDir ? path.join(config.dataDir, 'pglite') : null,
  })
}

export const parseArgs = (argv: string[]) => {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!
    if (key.startsWith('--')) {
      args[key.slice(2)] = argv[i + 1] ?? ''
      i++
    }
  }
  return args
}
