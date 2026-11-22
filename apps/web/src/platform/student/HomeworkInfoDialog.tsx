import type { Homework, StudentHomework } from '@hw/shared'
import { Modal } from '../../components/base/Modal.js'
import { Markdown } from '../../components/markdown/Markdown.js'
import { usePt } from '../i18n.js'
import { ui } from '../ui/components.js'
import { formatDateTime } from '../ui/format.js'
import styles from './student.module.css'

export const HomeworkInfoDialog = ({
  homework,
  onClose,
}: {
  homework: StudentHomework | Homework
  onClose: () => void
}) => {
  const pt = usePt()
  return (
    <Modal title={homework.title} closable className={styles.dialog} onClose={onClose}>
      <div className={ui.stack}>
        <div className={ui.muted}>
          {pt('startsAt', { time: formatDateTime(homework.startAt) })} ·{' '}
          {pt('dueAt', { time: formatDateTime(homework.dueAt) })}
        </div>
        <div className={styles.description}>
          <Markdown
            content={homework.description || '—'}
            loading={false}
            cacheKey={`hw-${homework.id}`}
            disableLink={false}
            className="ds-assistant-message-main-content"
          />
        </div>
      </div>
    </Modal>
  )
}
