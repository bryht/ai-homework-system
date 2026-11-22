export type SseEvent = { event: string; data: string }

/**
 * 增量解析 SSE：feed 收到的文本块，返回已经完整的事件。
 * 网关一边把原始字节转发给浏览器，一边用它解析出事件来拼完整回答。
 */
export class SseParser {
  private buffer = ''

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n')
    const events: SseEvent[] = []
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const event = parseEvent(raw)
      if (event) {
        events.push(event)
      }
      boundary = this.buffer.indexOf('\n\n')
    }
    return events
  }
}

const parseEvent = (raw: string): SseEvent | null => {
  let event = 'message'
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') {
      event = value
    } else if (field === 'data') {
      data.push(value)
    }
  }
  return data.length ? { event, data: data.join('\n') } : null
}

export const encodeSse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
