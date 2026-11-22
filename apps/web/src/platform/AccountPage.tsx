import { useState } from 'react'
import { Button } from '../components/base/Button.js'
import { showToast } from '../components/base/toastState.js'
import { setLocale, useSettings } from '../services/settings.js'
import { api } from './api.js'
import { usePt } from './i18n.js'
import { useSession } from './session.js'
import { Card, Field, TextInput, TitleRow, ui } from './ui/components.js'

export const AccountPage = () => {
  const pt = usePt()
  const user = useSession((s) => s.user)
  const locale = useSettings((s) => s.locale)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const save = async () => {
    setPending(true)
    setError(null)
    try {
      await api('/api/auth/password', {
        method: 'POST',
        json: { currentPassword: current, newPassword: next },
      })
      setCurrent('')
      setNext('')
      showToast(pt('passwordChanged'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <TitleRow title={pt('account')} back={{ name: 'home' }} />
      <div className={ui.stack} style={{ maxWidth: 480 }}>
        <Card>
          <div className={ui.stack}>
            <div>
              <div className={ui.label}>{user?.name}</div>
              <div className={ui.muted}>
                {pt('username')}: {user?.username}
              </div>
            </div>
            <div className={ui.row}>
              <Button
                variant="outlined"
                size="m"
                onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}
              >
                {locale === 'zh-CN' ? 'Switch to English' : '切换到中文'}
              </Button>
            </div>
          </div>
        </Card>
        <Card>
          <form
            className={ui.stack}
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <h2 className={ui.sectionTitle}>{pt('changePassword')}</h2>
            <Field label={pt('currentPassword')}>
              <TextInput
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label={pt('newPassword')}>
              <TextInput
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            {error ? <div className={ui.error}>{error}</div> : null}
            <div>
              <Button type="submit" size="m" disabled={pending || !current || next.length < 8}>
                {pt('save')}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  )
}
