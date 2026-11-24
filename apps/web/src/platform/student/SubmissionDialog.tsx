import type { FileInfo, StudentHomework, Submission } from '@hw/shared'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { IconPaperclipOutline16 } from '../../components/base/icons.js'
import { Modal } from '../../components/base/Modal.js'
import { showToast } from '../../components/base/toastState.js'
import { Markdown } from '../../components/markdown/Markdown.js'
import { api, downloadFile } from '../api.js'
import { updateScopedHomework } from '../homeworkScope.js'
import { usePt } from '../i18n.js'
import { Checkbox, Field, TextArea, ui } from '../ui/components.js'
import { formatBytes, formatDateTime } from '../ui/format.js'
import styles from './student.module.css'

type SubmissionDraft = {
  revision: string | null
  content: string
  files: FileInfo[]
}

const restoreDraft = (key: string, revision: string | null): SubmissionDraft | null => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as SubmissionDraft | null
    return saved?.revision === revision &&
      typeof saved.content === 'string' &&
      Array.isArray(saved.files)
      ? saved
      : null
  } catch {
    return null
  }
}

export const SubmissionDialog = ({
  homework,
  userId,
  readOnly,
  canEdit,
  onEdit,
  onSubmitted,
  onClose,
}: {
  homework: StudentHomework
  userId: string
  readOnly: boolean
  canEdit: boolean
  onEdit: () => void
  onSubmitted: () => void
  onClose: () => void
}) => {
  const pt = usePt()
  const key = `hw-submission-draft:${userId}:${homework.id}`
  const submission = homework.submission
  const revision = submission?.updatedAt ?? null
  const [draft] = useState(() => (readOnly ? null : restoreDraft(key, revision)))
  const [content, setContent] = useState(draft?.content ?? submission?.content ?? '')
  const [files, setFiles] = useState<FileInfo[]>(draft?.files ?? submission?.files ?? [])
  const [pledged, setPledged] = useState(Boolean(submission))
  const [uploading, setUploading] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftSaveFailed, setDraftSaveFailed] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const submitted = useRef(false)
  const originalFiles = submission?.files ?? []
  const changed =
    content !== (submission?.content ?? '') ||
    files.length !== originalFiles.length ||
    files.some((file, index) => file.id !== originalFiles[index]?.id)

  useEffect(() => {
    if (readOnly || submitted.current) {
      return
    }
    try {
      if (changed) {
        localStorage.setItem(
          key,
          JSON.stringify({ revision, content, files } satisfies SubmissionDraft)
        )
      } else {
        localStorage.removeItem(key)
      }
      setDraftSaveFailed(false)
    } catch {
      setDraftSaveFailed(true)
    }
  }, [changed, content, files, key, readOnly, revision])

  const busy = pending || uploading > 0
  const close = () => {
    if (busy) {
      return
    }
    if (!readOnly && changed && draftSaveFailed) {
      setDiscardOpen(true)
    } else {
      onClose()
    }
  }

  const upload = async (list: File[]) => {
    for (const file of list) {
      setUploading((n) => n + 1)
      try {
        const form = new FormData()
        form.append('file', file)
        const { file: info } = await api<{ file: FileInfo }>(
          `/api/homeworks/${homework.id}/submission/files`,
          { method: 'POST', body: form }
        )
        setFiles((current) => [...current, info])
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const submit = async () => {
    setPending(true)
    setError(null)
    try {
      const { submission } = await api<{ submission: Submission }>(
        `/api/homeworks/${homework.id}/submission`,
        {
          method: 'PUT',
          json: { content, fileIds: files.map((f) => f.id) },
        }
      )
      submitted.current = true
      try {
        localStorage.removeItem(key)
      } catch {
        // A stale draft from an older submission revision will be ignored.
      }
      updateScopedHomework({ ...homework, submission })
      showToast(pt('submitSuccess'))
      onSubmitted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  const empty = !content.trim() && files.length === 0
  return (
    <>
      <Modal
        title={readOnly ? pt('submissionReceipt') : submission ? pt('resubmit') : pt('submitHomework')}
        closable
        className={styles.dialog}
        onClose={close}
        footer={
          readOnly ? (
            <>
              <Button variant="outlined" onClick={close}>
                {pt('close')}
              </Button>
              {canEdit ? <Button onClick={onEdit}>{pt('resubmit')}</Button> : null}
            </>
          ) : (
            <>
              <Button variant="outlined" onClick={close} disabled={busy}>
                {pt('close')}
              </Button>
              <Button onClick={() => void submit()} disabled={busy || empty || !pledged}>
                {pt('submit')}
              </Button>
            </>
          )
        }
      >
        <div className={ui.stack}>
          {submission ? (
            <div className={ui.muted}>
              {pt('lastSubmitted', { time: formatDateTime(submission.updatedAt) })}
              {submission.isLate ? ` · ${pt('lateTag')}` : ''}
              {readOnly ? (
                <div>
                  {pt(
                    !canEdit ? 'submissionEditsClosed' : homework.allowLateSubmission
                      ? 'submissionEditsLate'
                      : 'submissionEditsUntil',
                    { time: formatDateTime(homework.dueAt) }
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {readOnly ? (
            <Markdown
              content={content}
              loading={false}
              cacheKey={`submission-receipt-${submission?.id}-${revision}`}
              disableLink={false}
              className="ds-assistant-message-main-content"
            />
          ) : (
            <Field label={pt('submission')}>
              <TextArea
                rows={10}
                placeholder={pt('submissionPlaceholder')}
                value={content}
                disabled={pending}
                onChange={(e) => setContent(e.target.value)}
                autoFocus
              />
            </Field>
          )}
          {readOnly ? <div>{pt('submissionFiles')}</div> : null}
          <div className={styles.fileList}>
            {readOnly && files.length === 0 ? (
              <span className={ui.muted}>{pt('noSubmissionFiles')}</span>
            ) : null}
            {files.map((file) => (
              <span key={file.id} className={styles.fileItem}>
                <a
                  href={`#file-${file.id}`}
                  onClick={(event) => {
                    event.preventDefault()
                    void downloadFile(`/api/files/${file.id}`, file.filename).catch((e: unknown) =>
                      setError(String(e))
                    )
                  }}
                >
                  {file.filename}
                </a>
                <span className={ui.muted}>{formatBytes(file.size)}</span>
                {readOnly ? null : (
                  <button
                    type="button"
                    disabled={pending}
                    className={ui.linkButton}
                    onClick={() => setFiles((current) => current.filter((f) => f.id !== file.id))}
                  >
                    {pt('removeFile')}
                  </button>
                )}
              </span>
            ))}
            {readOnly ? null : (
              <>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={busy}
                  onClick={() => inputRef.current?.click()}
                >
                  <IconPaperclipOutline16 />
                  {uploading > 0 ? pt('uploading') : pt('attachFiles')}
                </Button>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    void upload(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
              </>
            )}
          </div>
          {readOnly ? null : (
            <>
              <Checkbox
                checked={pledged}
                onChange={setPledged}
                disabled={pending}
                label={pt('integrityPledge')}
              />
              {changed ? (
                <div className={draftSaveFailed ? ui.error : ui.muted} role="status">
                  {pt(draftSaveFailed ? 'draftSaveFailed' : 'draftSavedOnDevice')}
                </div>
              ) : null}
            </>
          )}
          {error ? (
            <div className={ui.error} role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </Modal>
      {discardOpen ? (
        <Modal
          title={pt('discardDraft')}
          onClose={() => setDiscardOpen(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setDiscardOpen(false)}>
                {pt('cancel')}
              </Button>
              <Button variant="danger" onClick={onClose}>
                {pt('discardDraft')}
              </Button>
            </>
          }
        >
          {pt('confirmDiscardDraft')}
        </Modal>
      ) : null}
    </>
  )
}
