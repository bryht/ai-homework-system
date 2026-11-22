import { randomBytes } from 'node:crypto'

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** 带前缀的随机 ID，例如 hw_k3m9x2...；前缀方便在日志里分辨类型 */
export const newId = (prefix: string, length = 16): string => {
  const bytes = randomBytes(length)
  let id = ''
  for (const byte of bytes) {
    id += ALPHABET[byte % ALPHABET.length]
  }
  return `${prefix}_${id}`
}

/** 给学生的初始密码：去掉易混淆字符，10 位 */
export const newPassword = (): string => newId('x', 10).slice(2)
