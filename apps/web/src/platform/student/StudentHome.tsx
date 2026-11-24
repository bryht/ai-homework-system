import type { StudentHomework } from '@hw/shared'
import { Button } from '../../components/base/Button.js'
import { api } from '../api.js'
import { usePt } from '../i18n.js'
import { navigate } from '../router.js'
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Loading,
  PhaseBadge,
  TitleRow,
  ui,
} from '../ui/components.js'
import { describeRemaining, formatDateTime, formatNumber } from '../ui/format.js'
import { useAsync } from '../ui/hooks.js'
import styles from './student.module.css'

type HomeworkGroup = 'toDo' | 'upcomingHomework' | 'submitted' | 'closedHomework'

const groupOf = (hw: StudentHomework): HomeworkGroup => {
  if (hw.submission) {
    return 'submitted'
  }
  if (hw.phase === 'upcoming') {
    return 'upcomingHomework'
  }
  if (hw.phase === 'closed' && !hw.allowLateSubmission) {
    return 'closedHomework'
  }
  return 'toDo'
}

const groups: HomeworkGroup[] = ['toDo', 'upcomingHomework', 'submitted', 'closedHomework']

export const StudentHome = () => {
  const pt = usePt()
  const { data, error, reload } = useAsync(
    () => api<{ homeworks: StudentHomework[] }>('/api/homeworks'),
    []
  )

  return (
    <>
      <TitleRow title={pt('myHomework')} />
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : data.homeworks.length === 0 ? (
        <Empty>{pt('noHomework')}</Empty>
      ) : (
        <div className={ui.stack}>
          {groups.map((group) => {
            const homeworks = data.homeworks
              .filter((homework) => groupOf(homework) === group)
              .sort((a, b) =>
                group === 'toDo' || group === 'upcomingHomework'
                  ? a.dueAt.localeCompare(b.dueAt)
                  : b.dueAt.localeCompare(a.dueAt)
              )
            return homeworks.length ? (
              <section key={group}>
                <h2 className={ui.sectionTitle}>{pt(group)}</h2>
                <div className={ui.cardGrid}>
                  {homeworks.map((hw) => (
                    <HomeworkCard key={hw.id} homework={hw} />
                  ))}
                </div>
              </section>
            ) : null
          })}
        </div>
      )}
    </>
  )
}

const HomeworkCard = ({ homework: hw }: { homework: StudentHomework }) => {
  const pt = usePt()
  const budget = hw.usage.tokenBudget
  return (
    <Card className={`${styles.homeworkCard} ${styles[`phase-${hw.phase}`] ?? ''}`}>
      <div className={ui.row}>
        <PhaseBadge phase={hw.phase} />
        {hw.submission ? (
          <Badge tone={hw.submission.isLate ? 'warn' : 'open'}>
            {pt('submitted')}
            {hw.submission.isLate ? ` · ${pt('lateTag')}` : ''}
          </Badge>
        ) : (
          <Badge>{pt('notSubmitted')}</Badge>
        )}
        <span className={ui.muted}>{hw.className}</span>
      </div>
      <h3 className={styles.cardTitle}>{hw.title}</h3>
      <div className={styles.cardMeta}>
        <div>{pt('dueAt', { time: formatDateTime(hw.dueAt) })}</div>
        {hw.phase === 'upcoming' ? (
          <div>{pt('startsAt', { time: formatDateTime(hw.startAt) })}</div>
        ) : null}
      </div>
      <div className={styles.cardFooter}>
        <span className={styles.remaining}>
          {hw.phase === 'closed'
            ? budget
              ? pt('tokensUsed', {
                  used: formatNumber(hw.usage.tokens),
                  budget: formatNumber(budget),
                })
              : pt('tokensUsedUnlimited', { used: formatNumber(hw.usage.tokens) })
            : describeRemaining(hw.phase, hw.startAt, hw.dueAt, pt)}
        </span>
        <Button
          size="m"
          variant={hw.phase === 'open' ? 'primary' : 'outlined'}
          disabled={hw.phase === 'upcoming'}
          onClick={() => navigate({ name: 'chat', homeworkId: hw.id })}
        >
          {hw.phase === 'closed' && !hw.allowLateSubmission
            ? pt('viewHomework')
            : pt('enterHomework')}
        </Button>
      </div>
    </Card>
  )
}
