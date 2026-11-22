import type { HomeworkOverview } from '@hw/shared'
import { Button } from '../../components/base/Button.js'
import { api } from '../api.js'
import { usePt } from '../i18n.js'
import { navigate } from '../router.js'
import {
  Badge,
  Empty,
  ErrorState,
  Loading,
  PhaseBadge,
  Stat,
  TitleRow,
  ui,
} from '../ui/components.js'
import { formatDateTime, formatNumber } from '../ui/format.js'
import { useAsync } from '../ui/hooks.js'

export const HomeworkOverviewPage = ({ homeworkId }: { homeworkId: string }) => {
  const pt = usePt()
  const { data, error, reload } = useAsync(
    () => api<HomeworkOverview>(`/api/homeworks/${homeworkId}/overview`),
    [homeworkId]
  )
  if (error) {
    return <ErrorState message={error} onRetry={reload} />
  }
  if (!data) {
    return <Loading />
  }
  const { homework, students } = data
  const total = students.length
  const submitted = students.filter((s) => s.submission).length
  const active = students.filter((s) => s.turns > 0).length
  const turns = students.reduce((sum, s) => sum + s.turns, 0)
  return (
    <>
      <TitleRow
        title={homework.title}
        back={{ name: 'home' }}
        actions={
          <>
            <Button
              size="m"
              variant="outlined"
              onClick={() => navigate({ name: 'homeworkEdit', homeworkId })}
            >
              {pt('edit')}
            </Button>
            <Button
              size="m"
              variant="outlined"
              onClick={() => navigate({ name: 'chat', homeworkId })}
            >
              {pt('previewAi')}
            </Button>
            <a href={`/api/homeworks/${homeworkId}/export.csv`} download>
              <Button size="m" variant="outlined" tabIndex={-1}>
                {pt('exportCsv')}
              </Button>
            </a>
          </>
        }
      />
      <div className={ui.subtitle}>
        <span className={ui.row}>
          <PhaseBadge phase={homework.phase} draft={homework.status === 'draft'} />
          <span>{homework.className}</span>
          <span>·</span>
          <span>
            {formatDateTime(homework.startAt)} – {formatDateTime(homework.dueAt)}
          </span>
        </span>
      </div>
      <div className={ui.stats}>
        <Stat value={`${submitted} / ${total}`} label={pt('colSubmission')} />
        <Stat value={`${active} / ${total}`} label={pt('usedAi')} />
        <Stat value={formatNumber(turns)} label={pt('colTurns')} />
      </div>
      {total === 0 ? (
        <Empty>—</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>{pt('colStudent')}</th>
                <th className={ui.num}>{pt('colTurns')}</th>
                <th className={ui.num}>{pt('colTokens')}</th>
                <th className={ui.num}>{pt('colActiveDays')}</th>
                <th>{pt('colLastActive')}</th>
                <th>{pt('colSubmission')}</th>
                <th className={ui.num}>{pt('colScore')}</th>
              </tr>
            </thead>
            <tbody>
              {students.map((row) => (
                <tr
                  key={row.student.id}
                  className={ui.clickableRow}
                  onClick={() =>
                    navigate({ name: 'student', homeworkId, studentId: row.student.id })
                  }
                >
                  <td>
                    <a
                      href={`#/teacher/hw/${homeworkId}/students/${row.student.id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {row.student.name}
                    </a>{' '}
                    <span className={`${ui.muted} ${ui.small}`}>{row.student.username}</span>
                  </td>
                  <td className={ui.num}>{row.turns}</td>
                  <td className={ui.num}>{formatNumber(row.tokens)}</td>
                  <td className={ui.num}>{row.activeDays}</td>
                  <td className={ui.muted}>
                    {row.lastActiveAt ? formatDateTime(row.lastActiveAt) : pt('never')}
                  </td>
                  <td>
                    {row.submission ? (
                      <Badge tone={row.submission.isLate ? 'warn' : 'open'}>
                        {formatDateTime(row.submission.submittedAt)}
                        {row.submission.isLate ? ` · ${pt('lateTag')}` : ''}
                      </Badge>
                    ) : (
                      <Badge>{pt('notSubmitted')}</Badge>
                    )}
                  </td>
                  <td className={ui.num}>{row.grade?.score ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
