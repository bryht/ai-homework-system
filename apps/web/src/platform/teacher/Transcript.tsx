import type { ContentBlock, Conversation, FileInfo, Turn } from '@hw/shared'
import { IconPaperclipOutline16, IconSearchOutline16 } from '../../components/base/icons.js'
import { Markdown } from '../../components/markdown/Markdown.js'
import { showToast } from '../../components/base/toastState.js'
import { downloadFile } from '../api.js'
import { usePt, type PlatformKey } from '../i18n.js'
import { Badge, ui } from '../ui/components.js'
import { formatBytes, formatDateTime, formatNumber } from '../ui/format.js'
import styles from './transcript.module.css'

const KIND_LABEL: Record<Turn['kind'], PlatformKey> = {
  new: 'kindNew',
  edit: 'kindEdit',
  regenerate: 'kindRegenerate',
  continue: 'kindContinue',
}

const textOf = (blocks: ContentBlock[]) =>
  blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text))
    .join('')

export const FileChip = ({ file }: { file: FileInfo }) => (
  <a
    className={ui.fileChip}
    href={`#file-${file.id}`}
    onClick={(event) => {
      event.preventDefault()
      void downloadFile(`/api/files/${file.id}`, file.filename).catch((e: unknown) =>
        showToast(String(e))
      )
    }}
  >
    <IconPaperclipOutline16 />
    {file.filename} <span className={ui.muted}>{formatBytes(file.size)}</span>
  </a>
)

/** 老师查看学生对话：按时间顺序列出每一轮，包括重新生成、编辑和中途停止的记录 */
export const ConversationView = ({ conversation }: { conversation: Conversation }) => {
  const pt = usePt()
  return (
    <section className={styles.conversation}>
      <header className={styles.conversationHeader}>
        <span className={ui.label}>{conversation.title || pt('untitledConversation')}</span>
        <span className={ui.muted}>
          {formatDateTime(conversation.createdAt)} ·{' '}
          {pt('turnCount', { n: conversation.turns.length })}
        </span>
      </header>
      <div className={styles.turns}>
        {conversation.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
      </div>
    </section>
  )
}

const TurnView = ({ turn }: { turn: Turn }) => {
  const pt = usePt()
  const question = textOf(turn.userContent)
  return (
    <div className={styles.turn}>
      <div className={styles.meta}>
        <span>{formatDateTime(turn.createdAt)}</span>
        {turn.kind !== 'new' ? <Badge tone="upcoming">{pt(KIND_LABEL[turn.kind])}</Badge> : null}
        {turn.status === 'aborted' ? (
          <Badge tone="warn">
            {pt(turn.stopReason === 'user_stop' ? 'statusStopped' : 'statusAborted')}
          </Badge>
        ) : null}
        {turn.status === 'streaming' ? <Badge tone="warn">{pt('statusStreaming')}</Badge> : null}
        <span className={styles.tokens}>
          {pt('tokensLabel', {
            input: formatNumber(turn.inputTokens),
            output: formatNumber(turn.outputTokens),
          })}
        </span>
      </div>
      <div className={styles.user}>
        {question ? <div className={styles.userText}>{question}</div> : null}
        {turn.files.length ? (
          <div className={styles.files}>
            {turn.files.map((file) => (
              <FileChip key={file.id} file={file} />
            ))}
          </div>
        ) : null}
      </div>
      <div className={styles.assistant}>
        {turn.assistantContent.map((block, index) => (
          <AssistantBlock key={index} block={block} turnId={turn.id} index={index} />
        ))}
        {turn.status === 'error' ? (
          <div className={ui.error}>
            {pt('statusError', { message: (turn.error ?? '').slice(0, 300) })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

const AssistantBlock = ({
  block,
  turnId,
  index,
}: {
  block: ContentBlock
  turnId: string
  index: number
}) => {
  const pt = usePt()
  switch (block.type) {
    case 'thinking':
      return String(block.thinking ?? '').trim() ? (
        <details className={styles.thinking}>
          <summary>{pt('thinkingLabel')}</summary>
          <div className={styles.thinkingText}>{String(block.thinking)}</div>
        </details>
      ) : null
    case 'text':
      return (
        <Markdown
          content={String(block.text ?? '')}
          loading={false}
          cacheKey={`${turnId}-${index}`}
          disableLink={false}
          className="ds-assistant-message-main-content"
        />
      )
    case 'server_tool_use': {
      const input = (block.input ?? {}) as {
        action?: string
        queries?: string[]
        query?: string
        url?: string
      }
      const label =
        input.action === 'search'
          ? pt('searchLabel', { query: (input.queries ?? [input.query ?? '']).join(' / ') })
          : input.url
            ? pt('readLinkLabel', { url: input.url })
            : String(block.name ?? '')
      return (
        <div className={styles.tool}>
          <IconSearchOutline16 /> {label}
        </div>
      )
    }
    case 'web_search_tool_result': {
      const results = (Array.isArray(block.content) ? block.content : []) as {
        title?: string
        url?: string
      }[]
      const visible = results.filter((r) => r.url)
      return visible.length ? (
        <details className={styles.tool}>
          <summary>{pt('searchResults', { n: visible.length })}</summary>
          <ul className={styles.results}>
            {visible.map((r) => (
              <li key={r.url}>
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.title || r.url}
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null
    }
    default:
      return null
  }
}
