import type { Homework, StudentHomework } from '@hw/shared'
import { useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { useHomeworkScope } from '../homeworkScope.js'
import { usePt } from '../i18n.js'
import { routeHref } from '../router.js'
import { useSession } from '../session.js'
import { Badge, PhaseBadge } from '../ui/components.js'
import { formatDateTime } from '../ui/format.js'
import { HomeworkInfoDialog } from './HomeworkInfoDialog.js'
import { SubmissionDialog } from './SubmissionDialog.js'
import styles from './student.module.css'

const isStudentView = (hw: StudentHomework | Homework): hw is StudentHomework => 'ai' in hw

/** 聊天页顶部：返回、作业标题与剩余时间、「本对话会被老师查看」提示、作业要求和提交入口 */
export const HomeworkBar = ({
  showingInstructions = false,
  showReceipt = false,
}: {
  showingInstructions?: boolean
  showReceipt?: boolean
}) => {
  const pt = usePt()
  const homework = useHomeworkScope((s) => s.homework)
  const user = useSession((s) => s.user)
  const [dialog, setDialog] = useState<'info' | 'submit' | 'receipt' | null>(showReceipt ? 'receipt' : null)
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
        <a
          className={styles.barBack}
          href={routeHref(student ? { name: 'home' } : { name: 'homeworkEdit', homeworkId: homework.id })}
        >
          ← {pt(student ? 'backToList' : 'backToEditor')}
        </a>
        <div className={styles.barMain}>
          <div className={styles.barTitle}>
            {showingInstructions ? null : <span className={styles.assignmentTitle}>{homework.title}</span>}
            <PhaseBadge phase={homework.phase} draft={homework.status === 'draft'} />
            {student ? (
              <Badge
                tone={
                  student.submission ? (student.submission.isLate ? 'warn' : 'open') : 'neutral'
                }
              >
                {pt(student.submission ? 'submitted' : 'notSubmitted')}
              </Badge>
            ) : null}
          </div>
          <div className={styles.barMeta}>
            {showingInstructions ? null : (
              <span>{pt('dueAt', { time: formatDateTime(homework.dueAt) })}</span>
            )}
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
        {!showingInstructions || student?.submission || canSubmit ? (
          <div className={styles.barActions}>
            {showingInstructions ? null : (
              <Button variant="outlined" size="s" onClick={() => setDialog('info')}>
                {pt('homeworkInstructions')}
              </Button>
            )}
            {student?.submission ? (
              <Button variant="outlined" size="s" onClick={() => setDialog('receipt')}>
                {pt('viewSubmission')}
              </Button>
            ) : null}
            {canSubmit && !student.submission ? (
              <Button variant="outlined" size="s" onClick={() => setDialog('submit')}>
                {pt('submitHomework')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {student && homework.phase === 'closed' ? (
        <div className={styles.banner}>{pt('closedNotice')}</div>
      ) : null}
      {dialog === 'info' ? (
        <HomeworkInfoDialog homework={homework} onClose={() => setDialog(null)} />
      ) : null}
      {student && ((dialog === 'submit' && canSubmit) || (dialog === 'receipt' && student.submission)) ? (
        <SubmissionDialog
          homework={student}
          userId={user.id}
          key={dialog}
          readOnly={dialog === 'receipt'}
          canEdit={Boolean(canSubmit)}
          onEdit={() => setDialog('submit')}
          onSubmitted={() => setDialog('receipt')}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  )
}
