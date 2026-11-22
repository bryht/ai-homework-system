import { createHash } from 'node:crypto'
import type { Deps } from './context.js'
import { files } from './db/schema.js'
import { HttpError } from './lib/errors.js'
import { newId } from './lib/ids.js'

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

/** 保存原始文件到存储（按 sha256 去重），并在 files 表登记 */
export const saveUpload = async (
  deps: Deps,
  options: { ownerId: string; homeworkId: string; purpose: 'chat' | 'submission'; file: File }
) => {
  const { file } = options
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, {
      zh: `文件不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
      en: `Files must be smaller than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
    })
  }
  const data = new Uint8Array(await file.arrayBuffer())
  const sha256 = createHash('sha256').update(data).digest('hex')
  const storageKey = `files/${sha256.slice(0, 2)}/${sha256}`
  await deps.storage.put(storageKey, data)
  const [row] = await deps.db
    .insert(files)
    .values({
      id: newId('file'),
      ownerId: options.ownerId,
      homeworkId: options.homeworkId,
      purpose: options.purpose,
      filename: file.name || 'file',
      mimeType: file.type || 'application/octet-stream',
      size: data.byteLength,
      sha256,
      storageKey,
    })
    .returning()
  return { row: row!, data }
}

export const readUploadForm = async (request: Request, field = 'file') => {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    throw new HttpError(400, { zh: '上传格式错误', en: 'Invalid upload' })
  }
  const file = form.get(field)
  if (!(file instanceof File)) {
    throw new HttpError(400, { zh: '没有收到文件', en: 'No file received' })
  }
  return { form, file }
}
