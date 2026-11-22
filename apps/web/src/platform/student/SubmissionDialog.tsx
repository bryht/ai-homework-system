import type { FileInfo, StudentHomework, Submission } from '@hw/shared'
import { useRef, useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { IconPaperclipOutline16 } from '../../components/base/icons.js'
import { Modal } from '../../components/base/Modal.js'
import { showToast } from '../../components/base/toastState.js'
import { api, downloadFile } from '../api.js'
import { updateScopedHomework } from '../homeworkScope.js'
import { usePt } from '../i18n.js'
import { Checkbox, TextArea, ui } from '../ui/components.js'
import { formatBytes, formatDateTime } from '../ui/format.js'
import styles from './student.module.css'

export const SubmissionDialog = ({
  homework,
  onClose,
}: {
  homework: StudentHomework
  onClose: () => void
}) => {
  const pt = usePt()
  const [content, setContent] = useState(homework.submission?.content ?? '')
  const [files, setFiles] = useState<FileInfo[]>(homework.submission?.files ?? [])
  const [pledged, setPledged] = useState(Boolean(homework.submission))
  const [uploading, setUploading] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
      updateScopedHomework({ ...homework, submission })
      showToast(pt('submitSuccess'))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  const empty = !content.trim() && files.length === 0
  return (
    <Modal
      title={homework.submission ? pt('resubmit') : pt('submitHomework')}
      closable
      className={styles.dialog}
      onClose={() => !pending && onClose()}
      footer={
        <>
          <Button variant="outlined" onClick={onClose} disabled={pending}>
            {pt('cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || uploading > 0 || empty || !pledged}
          >
            {pt('submit')}
          </Button>
        </>
      }
    >
      <div className={ui.stack}>
        {homework.submission ? (
          <div className={ui.muted}>
            {pt('lastSubmitted', { time: formatDateTime(homework.submission.updatedAt) })}
          </div>
        ) : null}
        <TextArea
          rows={10}
          placeholder={pt('submissionPlaceholder')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          autoFocus
        />
        <div className={styles.fileList}>
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
              <button
                type="button"
                className={ui.linkButton}
                onClick={() => setFiles((current) => current.filter((f) => f.id !== file.id))}
              >
                {pt('removeFile')}
              </button>
            </span>
          ))}
          <Button
            variant="outlined"
            size="s"
            disabled={uploading > 0}
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
        </div>
        <Checkbox checked={pledged} onChange={setPledged} label={pt('integrityPledge')} />
        {error ? <div className={ui.error}>{error}</div> : null}
      </div>
    </Modal>
  )
}
