import { GATEWAY_HEADERS, getHomeworkPhase, type TurnKind, type TurnStatus } from '@hw/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { loadHomeworkFor, type HomeworkAccess } from '../access.js'
import { requireUser } from '../auth.js'
import type { AppEnv, Deps } from '../context.js'
import { conversations, files, turns } from '../db/schema.js'
import { HttpError, badRequest } from '../lib/errors.js'
import { newId } from '../lib/ids.js'
import { tokensUsed } from '../stats.js'
import { readUploadForm, saveUpload } from '../uploads.js'
import { MessageAccumulator } from './accumulate.js'
import { buildUpstreamRequest, collectFileIds, lastUserIndex, toBlocks, type ClientRequest } from './policy.js'
import { UpstreamError, type Provider } from './providers.js'
import { SseParser } from './sse.js'

type FileRow = typeof files.$inferSelect

const header = (c: Context<AppEnv>, name: string) => c.req.header(name)?.trim() || null

/** 学生只能在作业开放期间使用 AI；老师预览不受限制 */
const assertCanChat = async (deps: Deps, access: HomeworkAccess, userId: string) => {
  if (access.isTeacher) {
    return
  }
  const { homework } = access
  const phase = getHomeworkPhase(homework.startAt, homework.dueAt, deps.now())
  if (phase === 'upcoming') {
    throw new HttpError(403, { zh: '作业还没有开始，暂时不能使用 AI', en: 'This homework has not started yet' })
  }
  if (phase === 'closed') {
    throw new HttpError(403, { zh: '作业已截止，不能再使用 AI', en: 'This homework is closed' })
  }
  const budget = homework.aiConfig.tokenBudget
  if (budget !== null && (await tokensUsed(deps.db, homework.id, userId)) >= budget) {
    throw new HttpError(403, {
      zh: '本作业的 AI 使用额度已用完，请联系老师',
      en: 'You have used up the AI quota for this homework. Please contact your teacher.',
    })
  }
}

const providerFor = (deps: Deps, model: string): Provider => {
  const provider = deps.providers.forModel(model)
  if (!provider) {
    throw new HttpError(503, {
      zh: `作业配置的模型「${model}」当前不可用，请联系老师`,
      en: `The model "${model}" configured for this homework is unavailable. Please contact your teacher.`,
    })
  }
  return provider
}

const uploadPurpose = (row: FileRow): string | null => {
  if (row.mimeType.startsWith('image/')) {
    return null
  }
  return /\.(pdf|docx?|pptx?)$/i.test(row.filename) ? 'rich_layout_recognition' : 'user_data'
}

/** 文件已经传给当前供应商就直接用；换了模型供应商时用存档的原件重新上传 */
const ensureProviderFile = async (deps: Deps, provider: Provider, row: FileRow, signal: AbortSignal) => {
  if (row.provider === provider.id && row.providerFileId) {
    return row.providerFileId
  }
  const data = await deps.storage.get(row.storageKey)
  const providerFileId = await provider.uploadFile(
    { data, filename: row.filename, mimeType: row.mimeType, purpose: uploadPurpose(row) },
    signal
  )
  await deps.db.update(files).set({ provider: provider.id, providerFileId }).where(eq(files.id, row.id))
  return providerFileId
}

const upstreamErrorResponse = (error: UpstreamError) =>
  new Response(error.body || JSON.stringify({ error: { type: 'api_error', message: 'Upstream error' } }), {
    status: error.status,
    headers: { 'Content-Type': 'application/json' },
  })

const inferKind = async (
  deps: Deps,
  conversationId: string,
  client: ClientRequest,
  userMessageId: string | null,
  parentMessageId: string | null
): Promise<TurnKind> => {
  if (client.messages.at(-1)?.role === 'assistant') {
    return 'continue'
  }
  if (userMessageId) {
    const [same] = await deps.db
      .select({ id: turns.id })
      .from(turns)
      .where(and(eq(turns.conversationId, conversationId), eq(turns.userMessageId, userMessageId)))
      .limit(1)
    if (same) {
      return 'regenerate'
    }
    const [sibling] = await deps.db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.conversationId, conversationId),
          parentMessageId ? eq(turns.parentMessageId, parentMessageId) : isNull(turns.parentMessageId)
        )
      )
      .limit(1)
    if (sibling) {
      return 'edit'
    }
  }
  return 'new'
}

const upsertConversation = async (deps: Deps, homeworkId: string, userId: string, clientSessionId: string) => {
  const [row] = await deps.db
    .insert(conversations)
    .values({ id: newId('conv'), homeworkId, userId, clientSessionId })
    .onConflictDoUpdate({
      target: [conversations.homeworkId, conversations.userId, conversations.clientSessionId],
      set: { updatedAt: deps.now() },
    })
    .returning()
  return row!
}

export const gatewayRoutes = new Hono<AppEnv>()
  .post('/messages', async (c) => {
    const deps = c.var.deps
    const user = requireUser(c)
    const homeworkId = header(c, GATEWAY_HEADERS.homeworkId)
    const clientSessionId = header(c, GATEWAY_HEADERS.conversationId)
    if (!homeworkId || !clientSessionId) {
      throw badRequest('缺少作业或会话信息，请刷新页面', 'Missing homework or conversation. Please reload the page.')
    }
    const access = await loadHomeworkFor(deps.db, homeworkId, user)
    await assertCanChat(deps, access, user.id)
    const { homework } = access
    const provider = providerFor(deps, homework.aiConfig.model)

    let client: ClientRequest
    try {
      client = (await c.req.json()) as ClientRequest
    } catch {
      throw badRequest('请求格式错误', 'Invalid JSON body')
    }
    if (!Array.isArray(client?.messages) || lastUserIndex(client.messages) === -1) {
      throw badRequest('消息不能为空', 'Messages must not be empty')
    }

    const abort = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => abort.abort())

    // 文件只能引用自己在本作业里上传的
    const fileIds = collectFileIds(client.messages)
    const fileRows = fileIds.length
      ? await deps.db
          .select()
          .from(files)
          .where(and(inArray(files.id, fileIds), eq(files.ownerId, user.id), eq(files.homeworkId, homework.id)))
      : []
    const fileMap = new Map<string, string>()
    if (homework.aiConfig.allowFileUpload) {
      try {
        for (const row of fileRows) {
          fileMap.set(row.id, await ensureProviderFile(deps, provider, row, abort.signal))
        }
      } catch (error) {
        if (error instanceof UpstreamError) {
          return upstreamErrorResponse(error)
        }
        throw error
      }
    }
    const { body, hasFiles } = buildUpstreamRequest(client, homework, fileMap)

    const conversation = await upsertConversation(deps, homework.id, user.id, clientSessionId)
    const userMessageId = header(c, GATEWAY_HEADERS.userMessageId)
    const parentMessageId = header(c, GATEWAY_HEADERS.parentMessageId)
    const kind = await inferKind(deps, conversation.id, client, userMessageId, parentMessageId)
    const lastUser = client.messages[lastUserIndex(client.messages)]!
    const turnFileIds = collectFileIds([lastUser]).filter((id) => fileRows.some((row) => row.id === id))
    const turnId = newId('turn')
    const startedAt = Date.now()
    await deps.db.insert(turns).values({
      id: turnId,
      conversationId: conversation.id,
      homeworkId: homework.id,
      userId: user.id,
      kind,
      status: 'streaming',
      userMessageId,
      parentMessageId,
      assistantMessageId: header(c, GATEWAY_HEADERS.assistantMessageId),
      userContent: toBlocks(lastUser.content),
      fileIds: turnFileIds,
      model: homework.aiConfig.model,
      requestMeta: {
        thinking: (body.thinking as { type: string }).type === 'enabled',
        webSearch: Array.isArray(body.tools) && body.tools.length > 0,
        preview: access.isTeacher,
      },
      createdAt: deps.now(),
    })

    const acc = new MessageAccumulator()
    let finished = false
    const finish = async (status: TurnStatus, error: string | null = null) => {
      if (finished) {
        return
      }
      finished = true
      await deps.db
        .update(turns)
        .set({
          status,
          error: error ?? acc.error,
          assistantContent: acc.content(),
          inputTokens: acc.inputTokens(),
          outputTokens: acc.outputTokens(),
          stopReason: acc.stopReason,
          latencyMs: Date.now() - startedAt,
          completedAt: deps.now(),
        })
        .where(eq(turns.id, turnId))
      if (acc.title && !conversation.title) {
        await deps.db.update(conversations).set({ title: acc.title }).where(eq(conversations.id, conversation.id))
      }
    }

    let upstream: Response
    try {
      upstream = await provider.createMessage(body, { signal: abort.signal, hasFiles })
    } catch (error) {
      await finish(abort.signal.aborted ? 'aborted' : 'error', String(error))
      throw new HttpError(502, {
        zh: 'AI 服务暂时不可用，请稍后重试',
        en: 'The AI service is temporarily unavailable. Please try again.',
      }, 'api_error')
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      await finish('error', `upstream ${upstream.status}: ${text.slice(0, 2000)}`)
      return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
      })
    }

    const reader = upstream.body.getReader()
    const parser = new SseParser()
    const decoder = new TextDecoder()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            await finish(acc.done || acc.stopReason ? 'ok' : abort.signal.aborted ? 'aborted' : 'error',
              acc.done || acc.stopReason ? null : acc.error ?? 'stream ended before message_stop')
            return
          }
          controller.enqueue(value)
          for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
            acc.apply(event.event, event.data)
          }
        } catch (error) {
          await finish(abort.signal.aborted ? 'aborted' : 'error', abort.signal.aborted ? null : String(error))
          controller.error(error)
        }
      },
      async cancel() {
        // 学生点了「停止」或关闭页面
        abort.abort()
        await reader.cancel().catch(() => {})
        await finish('aborted')
      },
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    })
  })
  .post('/files', async (c) => {
    const deps = c.var.deps
    const user = requireUser(c)
    const homeworkId = header(c, GATEWAY_HEADERS.homeworkId)
    if (!homeworkId) {
      throw badRequest('缺少作业信息，请刷新页面', 'Missing homework. Please reload the page.')
    }
    const access = await loadHomeworkFor(deps.db, homeworkId, user)
    await assertCanChat(deps, access, user.id)
    if (!access.homework.aiConfig.allowFileUpload) {
      throw new HttpError(403, { zh: '本作业不允许上传文件', en: 'File uploads are disabled for this homework' })
    }
    const provider = providerFor(deps, access.homework.aiConfig.model)
    const { file } = await readUploadForm(c.req.raw)
    const { row } = await saveUpload(deps, { ownerId: user.id, homeworkId, purpose: 'chat', file })
    try {
      await ensureProviderFile(deps, provider, row, c.req.raw.signal)
    } catch (error) {
      if (error instanceof UpstreamError) {
        return upstreamErrorResponse(error)
      }
      throw error
    }
    return c.json({
      id: row.id,
      type: 'file',
      size_bytes: row.size,
      created_at: row.createdAt.toISOString(),
      filename: row.filename,
      mime_type: row.mimeType,
    })
  })
  // 原件和记录都保留给老师查看，这里只告诉前端删除成功
  .delete('/files/:id', (c) => {
    requireUser(c)
    return c.json({ id: c.req.param('id'), type: 'file_deleted', deleted: true })
  })
