import type { ClassInfo } from '@hw/shared'
import { useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { api } from '../api.js'
import { usePt } from '../i18n.js'
import { navigate } from '../router.js'
import { Card, Empty, ErrorState, Loading, TextInput, TitleRow, ui } from '../ui/components.js'
import { useAsync } from '../ui/hooks.js'

export const ClassesPage = () => {
  const pt = usePt()
  const { data, error, reload } = useAsync(() => api<{ classes: ClassInfo[] }>('/api/classes'), [])
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const create = async () => {
    setPending(true)
    setCreateError(null)
    try {
      const { class: klass } = await api<{ class: ClassInfo }>('/api/classes', {
        method: 'POST',
        json: { name },
      })
      navigate({ name: 'class', classId: klass.id })
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <TitleRow title={pt('classes')} />
      <div className={ui.stack}>
        <Card>
          <form
            className={ui.row}
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <TextInput
              style={{ flex: '1 1 240px', width: 'auto' }}
              placeholder={pt('className')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" size="m" disabled={pending || !name.trim()}>
              {pt('createClass')}
            </Button>
          </form>
          {createError ? <div className={ui.error}>{createError}</div> : null}
        </Card>
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data ? (
          <Loading />
        ) : data.classes.length === 0 ? (
          <Empty>{pt('noClasses')}</Empty>
        ) : (
          <div className={ui.cardGrid}>
            {data.classes.map((klass) => (
              <a
                key={klass.id}
                href={`#/teacher/classes/${klass.id}`}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <Card>
                  <div className={ui.label} style={{ fontSize: 16 }}>
                    {klass.name}
                  </div>
                  <div className={ui.muted}>{pt('studentCount', { n: klass.studentCount })}</div>
                </Card>
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
