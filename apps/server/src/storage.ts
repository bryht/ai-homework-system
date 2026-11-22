import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 上传文件的存储。第一期实现本地磁盘和内存两种；
 * 部署到磁盘不持久的平台时，按同一接口加一个 S3 兼容实现（Supabase Storage / Cloudflare R2）。
 */
export interface FileStorage {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array>
}

export const createDiskStorage = (root: string): FileStorage => {
  const resolve = (key: string) => {
    const target = path.resolve(root, key)
    if (!target.startsWith(path.resolve(root) + path.sep)) {
      throw new Error(`invalid storage key: ${key}`)
    }
    return target
  }
  return {
    async put(key, data) {
      const target = resolve(key)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, data)
    },
    async get(key) {
      return readFile(resolve(key))
    },
  }
}

export const createMemoryStorage = (): FileStorage => {
  const blobs = new Map<string, Uint8Array>()
  return {
    async put(key, data) {
      blobs.set(key, data)
    },
    async get(key) {
      const data = blobs.get(key)
      if (!data) {
        throw new Error(`missing file: ${key}`)
      }
      return data
    },
  }
}
