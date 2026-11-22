/**
 * 创建老师账号：
 *   pnpm --filter @hw/server create-teacher --username wang --name 王老师 [--password xxx]
 * 不传 --password 时随机生成并打印一次。
 */
import { eq } from 'drizzle-orm'
import { users } from '../db/schema.js'
import { newId, newPassword } from '../lib/ids.js'
import { hashPassword } from '../lib/password.js'
import { openFromEnv, parseArgs } from './shared.js'

const args = parseArgs(process.argv.slice(2))
const username = args.username?.trim().toLowerCase()
if (!username || !args.name) {
  console.error('Usage: create-teacher --username <username> --name <display name> [--password <password>]')
  process.exit(1)
}
const password = args.password || newPassword()
const { db, close } = await openFromEnv()
const [existing] = await db.select().from(users).where(eq(users.username, username))
if (existing) {
  console.error(`User "${username}" already exists`)
  await close()
  process.exit(1)
}
await db.insert(users).values({
  id: newId('usr'),
  role: 'teacher',
  name: args.name,
  username,
  passwordHash: await hashPassword(password),
})
console.log(`Teacher created: ${username}`)
if (!args.password) {
  console.log(`Password: ${password}`)
}
await close()
