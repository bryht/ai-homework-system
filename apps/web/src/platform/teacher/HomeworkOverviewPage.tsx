import type { HomeworkOverview, StudentProgress } from '@hw/shared'
import { useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { showToast } from '../../components/base/toastState.js'
import { api, downloadFile } from '../api.js'
import { usePt } from '../i18n.js'
import { navigate, routeHref } from '../router.js'
import {
  Badge,
  Empty,
  ErrorState,
  Loading,
  PhaseBadge,
  Stat,
  TextInput,
  Tabs,
  TitleRow,
  ui,
} from '../ui/components.js'
import { formatDateTime, formatNumber } from '../ui/format.js'
import { useAsync } from '../ui/hooks.js'

type StudentFilter = 'allStudents' | 'toGrade' | 'notSubmitted' | 'graded'

const reviewStatus = (row: StudentProgress): Exclude<StudentFilter, 'allStudents'> =>
  row.submission ? (row.grade ? 'graded' : 'toGrade') : 'notSubmitted'

export const HomeworkOverviewPage = ({ homeworkId }: { homeworkId: string }) => {
  const pt = usePt()
  const [filter, setFilter] = useState<StudentFilter>('allStudents')
  const [search, setSearch] = useState('')
  const [showActivity, setShowActivity] = useState(false)
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
  const query = search.trim().toLowerCase()
  const visible = students.filter(
    (row) =>
      (filter === 'allStudents' || reviewStatus(row) === filter) &&
      [row.student.name, row.student.username].some((value) => value.toLowerCase().includes(query))
  )
  const nextToGrade = students.find((row) => reviewStatus(row) === 'toGrade')
  const filters: StudentFilter[] = ['allStudents', 'toGrade', 'notSubmitted', 'graded']
  return (
    <>
      <TitleRow
        title={homework.title}
        back={{ name: 'home' }}
        actions={
          <>
            {nextToGrade ? (
              <Button
                size="m"
                onClick={() => navigate({ name: 'student', homeworkId, studentId: nextToGrade.student.id })}
              >
                {pt('startGrading')}
              </Button>
            ) : null}
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
            <Button
              size="m"
              variant="outlined"
              onClick={() =>
                void downloadFile(
                  `/api/homeworks/${homeworkId}/export.csv`,
                  `${homework.title}.csv`
                ).catch((e: unknown) => showToast(String(e)))
              }
            >
              {pt('exportCsv')}
            </Button>
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
        <Stat
          value={`${submitted} / ${total}`}
          label={pt('colSubmission')}
          progress={total ? submitted / total : 0}
        />
        <Stat
          value={`${active} / ${total}`}
          label={pt('usedAi')}
          progress={total ? active / total : 0}
        />
        <Stat value={formatNumber(turns)} label={pt('colTurns')} />
      </div>
      <Tabs
        value={filter}
        onChange={setFilter}
        options={filters.map((value) => ({
          value,
          label: `${pt(value)} (${value === 'allStudents' ? total : students.filter((row) => reviewStatus(row) === value).length})`,
        }))}
      />
      <div className={ui.row}>
        <label className={ui.row}>
          {pt('searchStudents')}
          <TextInput
            type="search"
            placeholder={pt('searchStudentsPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ width: 'auto', maxWidth: '100%' }}
          />
        </label>
        <Button
          size="s"
          variant="outlined"
          aria-expanded={showActivity}
          onClick={() => setShowActivity(!showActivity)}
        >
          {pt(showActivity ? 'hideActivity' : 'showActivity')}
        </Button>
      </div>
      {visible.length === 0 ? (
        <Empty>{pt('noMatchingStudents')}</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>{pt('colStudent')}</th>
                <th>{pt('submissionStatus')}</th>
                <th>{pt('grade')}</th>
                {showActivity ? (
                  <>
                    <th className={ui.num}>{pt('colTurns')}</th>
                    <th className={ui.num}>{pt('colTokens')}</th>
                    <th className={ui.num}>{pt('colActiveDays')}</th>
                    <th>{pt('colLastActive')}</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.student.id}
                  className={ui.clickableRow}
                  onClick={() =>
                    navigate({ name: 'student', homeworkId, studentId: row.student.id })
                  }
                >
                  <td>
                    <a
                      href={routeHref({ name: 'student', homeworkId, studentId: row.student.id })}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {row.student.name}
                    </a>{' '}
                    <span className={`${ui.muted} ${ui.small}`}>{row.student.username}</span>
                  </td>
                  <td>
                    {row.submission ? (
                      <Badge tone={row.submission.isLate ? 'warn' : 'open'}>
                        {pt('submitted')}{row.submission.isLate ? ` · ${pt('lateTag')}` : ''}
                      </Badge>
                    ) : (
                      <Badge>{pt('notSubmitted')}</Badge>
                    )}
                  </td>
                  <td>
                    {row.grade ? (row.grade.score ?? pt('graded')) : row.submission ? pt('toGrade') : '—'}
                  </td>
                  {showActivity ? (
                    <>
                      <td className={ui.num}>{row.turns}</td>
                      <td className={ui.num}>{formatNumber(row.tokens)}</td>
                      <td className={ui.num}>{row.activeDays}</td>
                      <td className={ui.muted}>
                        {row.lastActiveAt ? formatDateTime(row.lastActiveAt) : pt('never')}
                      </td>
                    </>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
