import type { Homework, StudentHomework } from '@hw/shared'
import { useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { useHomeworkScope } from '../homeworkScope.js'
import { usePt } from '../i18n.js'
import { routeHref } from '../router.js'
import { useSession } from '../session.js'
import { PhaseBadge } from '../ui/components.js'
import { describeRemaining, formatDateTime } from '../ui/format.js'
import { HomeworkInfoDialog } from './HomeworkInfoDialog.js'
import { SubmissionDialog } from './SubmissionDialog.js'
import styles from './student.module.css'

const isStudentView = (hw: StudentHomework | Homework): hw is StudentHomework => 'ai' in hw

/** 聊天页顶部：返回、作业标题与剩余时间、「本对话会被老师查看」提示、作业要求和提交入口 */
export const HomeworkBar = () => {
  const pt = usePt()
  const homework = useHomeworkScope((s) => s.homework)
  const user = useSession((s) => s.user)
  const [dialog, setDialog] = useState<'info' | 'submit' | null>(null)
  if (!homework || !user) {
    return null
  }
  const student = isStudentView(homework) ? homework : null
  const canSubmit =
    student &&
    (homework.phase === 'open' || (homework.phase === 'closed' && homework.allowLateSubmission))
  return (
    <>
      <div className={styles.bar}>
        <a className={styles.barBack} href={routeHref({ name: 'home' })}>
          ← {pt('backToList')}
        </a>
        <div className={styles.barMain}>
          <div className={styles.barTitle}>
            <span>{homework.title}</span>
            <PhaseBadge phase={homework.phase} />
          </div>
          <div className={styles.barMeta}>
            <span title={formatDateTime(homework.dueAt)}>
              {homework.phase === 'closed'
                ? pt('dueAt', { time: formatDateTime(homework.dueAt) })
                : describeRemaining(homework.phase, homework.startAt, homework.dueAt, pt)}
            </span>
            {student ? (
              <span className={styles.recorded}>
                <span aria-hidden>●</span>
                <span className={styles.recordedText}>{pt('recordedNotice')}</span>
              </span>
            ) : (
              <span>{pt('previewNotice')}</span>
            )}
          </div>
        </div>
        <div className={styles.barActions}>
          <Button variant="outlined" size="s" onClick={() => setDialog('info')}>
            {pt('homeworkInstructions')}
          </Button>
          {canSubmit ? (
            <Button size="s" onClick={() => setDialog('submit')}>
              {student.submission ? pt('resubmit') : pt('submitHomework')}
            </Button>
          ) : null}
        </div>
      </div>
      {student && homework.phase === 'closed' ? (
        <div className={styles.banner}>{pt('closedNotice')}</div>
      ) : null}
      {dialog === 'info' ? (
        <HomeworkInfoDialog homework={homework} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'submit' && student ? (
        <SubmissionDialog homework={student} onClose={() => setDialog(null)} />
      ) : null}
    </>
  )
}
