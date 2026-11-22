import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const scryptAsync = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)))
  })

const N = 16384
const r = 8
const p = 1
const KEYLEN = 32

/** 格式：scrypt$N$r$p$saltBase64$hashBase64 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r, p })
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$')
}

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [algo, n, rr, pp, salt, hash] = stored.split('$')
  if (algo !== 'scrypt' || !salt || !hash) {
    return false
  }
  const expected = Buffer.from(hash, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(rr),
    p: Number(pp),
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
