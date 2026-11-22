import type { ModelOption } from '@hw/shared'
import type { Config } from '../config.js'
import { encodeSse } from './sse.js'

export type UpstreamFile = {
  data: Uint8Array
  filename: string
  mimeType: string
  /** DeepSeek Files API 的 purpose；图片为 null */
  purpose: string | null
}

/**
 * 模型供应商。网关只和这个接口打交道：
 * createMessage 返回供应商原始的 SSE 响应（Anthropic Messages 格式），网关原样转发并解析存档。
 */
export interface Provider {
  id: string
  models: ModelOption[]
  createMessage(body: Record<string, unknown>, options: { signal: AbortSignal; hasFiles: boolean }): Promise<Response>
  uploadFile(file: UpstreamFile, signal?: AbortSignal): Promise<string>
}

export type ProviderRegistry = {
  models(): ModelOption[]
  forModel(model: string): Provider | undefined
}

const FILES_BETA = 'files-api-2025-04-14'

/** DeepSeek 的 Anthropic 兼容接口，和 chat-demo 原本直连的是同一套 */
export const createDeepSeekProvider = (options: { apiKey: string; baseUrl: string }): Provider => {
  const base = `${options.baseUrl}/anthropic/v1`
  const headers = (beta: boolean) => ({
    'x-api-key': options.apiKey,
    ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
  })
  return {
    id: 'deepseek',
    models: [
      {
        id: 'deepseek-flash',
        label: 'DeepSeek Flash',
        provider: 'deepseek',
        supportsThinking: true,
        supportsWebSearch: true,
        supportsFiles: true,
      },
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        provider: 'deepseek',
        supportsThinking: true,
        supportsWebSearch: true,
        supportsFiles: true,
      },
    ],
    createMessage(body, { signal, hasFiles }) {
      return fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          ...headers(hasFiles),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal,
      })
    },
    async uploadFile(file, signal) {
      const form = new FormData()
      if (file.purpose) {
        form.append('purpose', file.purpose)
      }
      form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename)
      const response = await fetch(`${base}/files`, {
        method: 'POST',
        headers: headers(true),
        body: form,
        signal,
      })
      if (!response.ok) {
        throw new UpstreamError(response.status, await response.text())
      }
      const json = (await response.json()) as { id?: string }
      if (!json.id) {
        throw new UpstreamError(502, 'upstream file upload returned no id')
      }
      return json.id
    },
  }
}

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`upstream error ${status}: ${body.slice(0, 200)}`)
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

const textOf = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
      .join('')
  }
  return ''
}

/**
 * 本地开发用的模拟模型：不调用任何外部服务，按 Anthropic 流式协议返回一段说明文字。
 * 回复里会显示网关实际注入的教学提示词，方便检查作业配置是否生效。
 */
export const createMockProvider = (options: { chunkDelayMs?: number } = {}): Provider => {
  const delay = options.chunkDelayMs ?? 15
  let fileSeq = 0
  return {
    id: 'mock',
    models: [
      {
        id: 'mock',
        label: 'Mock (local testing)',
        provider: 'mock',
        supportsThinking: true,
        supportsWebSearch: false,
        supportsFiles: true,
      },
    ],
    async createMessage(body, { signal }) {
      const messages = (body.messages as { role: string; content: unknown }[]) ?? []
      const last = [...messages].reverse().find((m) => m.role === 'user')
      const question = textOf(last?.content).trim()
      const fileCount = Array.isArray(last?.content)
        ? last.content.filter((b) => b && typeof b === 'object' && (b.type === 'image' || b.type === 'document')).length
        : 0
      const system = String(body.system ?? '')
      const zh = /[一-鿿]/.test(question + system)
      const thinking = (body.thinking as { type?: string } | undefined)?.type === 'enabled'
      const firstLine = system.split('\n').find((line) => line.trim()) ?? ''
      const quoted = question ? question.slice(0, 200).replace(/\n/g, '\n> ') : zh ? '（空）' : '(empty)'
      const reply = zh
        ? [
            '**（模拟回复）** 这是本地开发用的模拟模型，没有调用真实的 AI。',
            '',
            `你的问题：\n> ${quoted}`,
            fileCount ? `\n收到 ${fileCount} 个附件。` : '',
            '',
            `网关注入的教学提示词（第一行）：「${firstLine}」`,
            '',
            '配置 `DEEPSEEK_API_KEY` 后，作业会使用真实的 DeepSeek 模型。',
          ].join('\n')
        : [
            '**(Mock reply)** This is the local mock model. No real AI was called.',
            '',
            `Your question:\n> ${quoted}`,
            fileCount ? `\nReceived ${fileCount} attachment(s).` : '',
            '',
            `Teaching prompt injected by the gateway (first line): "${firstLine}"`,
            '',
            'Set `DEEPSEEK_API_KEY` to use the real DeepSeek model.',
          ].join('\n')
      const inputTokens = Math.ceil((system.length + JSON.stringify(messages).length) / 3)
      const outputTokens = Math.ceil(reply.length / 2)
      const wantsTitle = (body.title as { enabled?: boolean } | undefined)?.enabled === true
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(encodeSse(event, data)))
          const usage = { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
          send('message_start', {
            type: 'message_start',
            message: { id: crypto.randomUUID(), model: String(body.model), usage: { ...usage, output_tokens: 0 } },
          })
          let index = 0
          if (thinking) {
            send('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            })
            const thought = zh ? '模拟模型正在“思考”……' : 'The mock model is "thinking"...'
            send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: thought } })
            send('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'signature_delta', signature: 'mock' },
            })
            send('content_block_stop', { type: 'content_block_stop', index })
            index += 1
          }
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          for (let i = 0; i < reply.length && !signal.aborted; i += 12) {
            send('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text: reply.slice(i, i + 12) },
            })
            await sleep(delay, signal)
          }
          if (signal.aborted) {
            controller.close()
            return
          }
          send('content_block_stop', { type: 'content_block_stop', index })
          send('message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: 'end_turn',
              stop_sequence: null,
              ...(wantsTitle ? { title: question.slice(0, 20) || (zh ? '新对话' : 'New chat') } : {}),
            },
            usage: { ...usage, output_tokens: outputTokens },
          })
          send('message_stop', { type: 'message_stop' })
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    },
    async uploadFile() {
      fileSeq += 1
      return `mockfile_${fileSeq}`
    },
  }
}

export const createRegistry = (providers: Provider[]): ProviderRegistry => {
  const byModel = new Map<string, Provider>()
  for (const provider of providers) {
    for (const model of provider.models) {
      byModel.set(model.id, provider)
    }
  }
  return {
    models: () => providers.flatMap((p) => p.models),
    forModel: (model) => byModel.get(model),
  }
}

export const createRegistryFromConfig = (config: Config): ProviderRegistry => {
  const providers: Provider[] = []
  if (config.deepseek.apiKey) {
    providers.push(createDeepSeekProvider({ apiKey: config.deepseek.apiKey, baseUrl: config.deepseek.baseUrl }))
  }
  if (config.enableMock) {
    providers.push(createMockProvider())
  }
  return createRegistry(providers)
}
