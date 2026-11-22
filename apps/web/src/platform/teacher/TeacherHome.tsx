import type { ClassInfo, Homework } from '@hw/shared'
import { Button } from '../../components/base/Button.js'
import { api } from '../api.js'
import { usePt } from '../i18n.js'
import { navigate, routeHref } from '../router.js'
import { Empty, ErrorState, Loading, PhaseBadge, TitleRow, ui } from '../ui/components.js'
import { formatDateTime } from '../ui/format.js'
import { useAsync } from '../ui/hooks.js'

export const TeacherHome = () => {
  const pt = usePt()
  const { data, error, reload } = useAsync(async () => {
    const [{ homeworks }, { classes }] = await Promise.all([
      api<{ homeworks: Homework[] }>('/api/homeworks'),
      api<{ classes: ClassInfo[] }>('/api/classes'),
    ])
    return { homeworks, classes }
  }, [])
  const hasClasses = (data?.classes.length ?? 0) > 0
  return (
    <>
      <TitleRow
        title={pt('homeworks')}
        actions={
          hasClasses ? (
            <Button size="m" onClick={() => navigate({ name: 'homeworkNew' })}>
              {pt('newHomework')}
            </Button>
          ) : null
        }
      />
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : !hasClasses ? (
        <Empty>
          <span>{pt('noClasses')}</span>
          <Button size="m" onClick={() => navigate({ name: 'classes' })}>
            {pt('createClass')}
          </Button>
        </Empty>
      ) : data.homeworks.length === 0 ? (
        <Empty>{pt('noTeacherHomework')}</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>{pt('title')}</th>
                <th>{pt('klass')}</th>
                <th>{pt('startAt')}</th>
                <th>{pt('dueAt2')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.homeworks.map((hw) => (
                <tr key={hw.id}>
                  <td>
                    <div className={ui.row}>
                      <a href={routeHref({ name: 'homework', homeworkId: hw.id })}>{hw.title}</a>
                      <PhaseBadge phase={hw.phase} draft={hw.status === 'draft'} />
                    </div>
                  </td>
                  <td className={ui.muted}>{hw.className}</td>
                  <td className={ui.muted}>{formatDateTime(hw.startAt)}</td>
                  <td className={ui.muted}>{formatDateTime(hw.dueAt)}</td>
                  <td>
                    <div
                      className={ui.row}
                      style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}
                    >
                      <Button
                        size="s"
                        variant="outlined"
                        onClick={() => navigate({ name: 'homework', homeworkId: hw.id })}
                      >
                        {pt('overview')}
                      </Button>
                      <Button
                        size="s"
                        variant="outlined"
                        onClick={() => navigate({ name: 'homeworkEdit', homeworkId: hw.id })}
                      >
                        {pt('edit')}
                      </Button>
                      <Button
                        size="s"
                        variant="outlined"
                        onClick={() => navigate({ name: 'chat', homeworkId: hw.id })}
                      >
                        {pt('previewAi')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
