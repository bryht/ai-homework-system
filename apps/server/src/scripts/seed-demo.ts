/**
 * 本地试用的演示数据：一个老师、一个班、三个学生、一个进行中的作业。
 *   pnpm seed
 * 所有演示账号的密码都是 demo1234。重复执行不会重复创建。
 */
import { DEFAULT_AI_CONFIG } from '@hw/shared'
import { eq } from 'drizzle-orm'
import { classMembers, classes, homeworks, users } from '../db/schema.js'
import { newId } from '../lib/ids.js'
import { hashPassword } from '../lib/password.js'
import { openFromEnv } from './shared.js'

const PASSWORD = 'demo1234'
const { db, close } = await openFromEnv()

const [existing] = await db.select().from(users).where(eq(users.username, 'teacher'))
if (existing) {
  console.log('Demo data already exists. Accounts: teacher / student1 / student2 / student3, password demo1234')
  await close()
  process.exit(0)
}

const passwordHash = await hashPassword(PASSWORD)
const teacherId = newId('usr')
await db.insert(users).values({ id: teacherId, role: 'teacher', name: '王老师', username: 'teacher', passwordHash })
const classId = newId('cls')
await db.insert(classes).values({ id: classId, teacherId, name: '试点班' })
for (const [i, name] of ['张三', '李四', 'Alice Wang'].entries()) {
  const id = newId('usr')
  await db.insert(users).values({ id, role: 'student', name, username: `student${i + 1}`, passwordHash })
  await db.insert(classMembers).values({ classId, studentId: id })
}
const now = Date.now()
await db.insert(homeworks).values({
  id: newId('hw'),
  classId,
  title: '探究：一元二次方程的解法',
  description: [
    '用至少两种方法解方程 **x² − 5x + 6 = 0**，并回答：',
    '',
    '1. 每种方法的关键步骤是什么？',
    '2. 什么情况下用配方法比因式分解更合适？',
    '3. 自己编一道题，用公式法求解并验算。',
    '',
    '可以使用 AI 助手，但请把你的思考过程写进提交内容。',
  ].join('\n'),
  startAt: new Date(now - 86_400_000),
  dueAt: new Date(now + 13 * 86_400_000),
  status: 'published',
  aiConfig: { ...DEFAULT_AI_CONFIG, model: process.env.DEEPSEEK_API_KEY ? 'deepseek-flash' : 'mock' },
})
console.log('Demo data created. Accounts: teacher / student1 / student2 / student3, password demo1234')
await close()
