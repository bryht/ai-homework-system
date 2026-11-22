import type { ContentBlock } from '@hw/shared'

type Usage = { input_tokens?: number; output_tokens?: number; [key: string]: unknown }

/**
 * 把 Anthropic Messages 流式事件拼成完整的回答，用于落库。
 * 只关心存档需要的信息，不做展示层面的处理。
 */
export class MessageAccumulator {
  readonly blocks: ContentBlock[] = []
  usage: Usage = {}
  stopReason: string | null = null
  title: string | null = null
  error: string | null = null
  done = false
  model: string | null = null

  apply(event: string, data: string) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(data) as Record<string, unknown>
    } catch {
      if (event === 'error') {
        this.error = data
      }
      return
    }
    const error = payload.error as { message?: string } | undefined
    if (event === 'error' || (error && typeof error.message === 'string')) {
      this.error = error?.message ?? data
      return
    }
    switch (payload.type) {
      case 'message_start': {
        const message = payload.message as { model?: string; usage?: Usage } | undefined
        this.model = message?.model ?? null
        this.usage = { ...message?.usage }
        break
      }
      case 'content_block_start': {
        const index = payload.index as number
        this.blocks[index] = structuredClone(payload.content_block as ContentBlock)
        break
      }
      case 'content_block_delta': {
        const block = this.blocks[payload.index as number]
        const delta = payload.delta as Record<string, unknown>
        if (!block || !delta) {
          break
        }
        if (delta.type === 'text_delta') {
          block.text = String(block.text ?? '') + String(delta.text ?? '')
        } else if (delta.type === 'thinking_delta') {
          block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '')
        } else if (delta.type === 'signature_delta') {
          block.signature = delta.signature
        } else if (delta.type === 'citations_delta') {
          block.citations = [...((block.citations as unknown[]) ?? []), delta.citation]
        } else if (delta.type === 'input_json_delta') {
          block.partial_json = String(block.partial_json ?? '') + String(delta.partial_json ?? '')
        }
        break
      }
      case 'message_delta': {
        const delta = payload.delta as { stop_reason?: string; title?: string } | undefined
        this.stopReason = delta?.stop_reason ?? this.stopReason
        if (delta?.title?.trim()) {
          this.title = delta.title.trim()
        }
        // message_delta 的 usage 是全轮累计值，覆盖 message_start 中的初值
        this.usage = { ...this.usage, ...(payload.usage as Usage | undefined) }
        break
      }
      case 'message_stop':
        this.done = true
        break
    }
  }

  /** 去掉空洞（index 不连续时）后的内容块 */
  content(): ContentBlock[] {
    return this.blocks.filter(Boolean)
  }

  inputTokens() {
    const u = this.usage as Record<string, number | undefined>
    return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  }

  outputTokens() {
    return this.usage.output_tokens ?? 0
  }
}
